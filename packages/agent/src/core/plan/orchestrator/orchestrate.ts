/**
 * Main planner orchestrator — executePlannerPath entry point.
 *
 * @module
 */

import { PlannerTraceKind, VerifierOutcome } from "../../../domain/index.js"
import {
  buildEscalationInput,
  resolveEscalation,
  type EscalationDecision
} from "../../../runtime/delegate.js"
import type { Tool } from "../../types.js"
import { createBudgetState, maybeExtendBudget } from "../circuit-breaker.js"
import type { DelegateFn } from "../pipeline/index.js"
import { executePipeline } from "../pipeline/index.js"
import type { ExecutionEnvelope, PipelineResult, RepairPlan, VerifierDecision } from "../types.js"
import type { PlannerDecision } from "../types.js"
import { buildIssueIdentity, buildRepairPlan } from "../verification-model/index.js"
import { verify } from "../verifier/index.js"
import {
  applyVerificationAcceptanceStates,
  finalizePlannerRun,
  tryPlatformUnconfiguredShortCircuit
} from "./helpers.js"
import { checkStubCountRegression } from "./regression.js"
import { runPlannerSetup } from "./setup.js"
import { buildPipelineCallbacks, emitRetryTraces, emitVerificationTraces } from "./traces.js"
import type { PlannerContext, PlannerResult } from "./types.js"

/**
 * Widen a step's envelope tool allowlist to every tool the parent has
 * available before delegating. Used for `parent_guided` mode: economics
 * declined parallel fanout, but spawning a child per subagent step is still
 * cheaper than folding the work into the parent's own loop — as long as the
 * child isn't blocked by an over-tight per-step allowlist.
 */
function withFullToolAccess(delegateFn: DelegateFn, tools: readonly Tool[]): DelegateFn {
  const allToolNames = tools.map((t) => t.name)
  return (step, envelope) => {
    const widened: ExecutionEnvelope = {
      ...envelope,
      allowedTools: [...new Set([...envelope.allowedTools, ...allToolNames])]
    }
    return delegateFn(step, widened)
  }
}

export async function executePlannerPath(
  goal: string,
  ctx: PlannerContext,
  delegateFn: DelegateFn,
  options: { decision: PlannerDecision }
): Promise<PlannerResult> {
  const MAX_PIPELINE_RETRIES = 2
  const pipelineStartMs = Date.now()
  const banditTuner = ctx.delegationBanditTuner

  const setupOutcome = await runPlannerSetup(goal, ctx, options.decision)
  if (!setupOutcome.ready) return setupOutcome.result
  const { plan, runtimeModel, decision, banditTrajectory, executionMode } = setupOutcome.context

  // Tier 1 execution mode from the delegation gate — parallel fanout when
  // economics approve it, otherwise one child at a time. `parent_guided`
  // additionally widens each step's tool allowlist to the full parent tool
  // set so spawning a child adds less friction than a tight per-step scope.
  const maxParallel = executionMode === "parallel_children" ? 4 : 1
  const effectiveDelegateFn =
    executionMode === "parent_guided" ? withFullToolAccess(delegateFn, ctx.tools) : delegateFn

  let pipelineResult: PipelineResult | undefined
  let verifierDecision: VerifierDecision | undefined
  let retryOpts: {
    priorResults?: Map<string, import("../types.js").PipelineStepResult>
    repairPlan?: RepairPlan
  } = {}
  let verifierRounds = 0
  const priorStepIssues = new Map<string, string>()
  const priorStubCounts = new Map<string, number>()
  let forceReplanForFatalPattern = false
  let budgetState = createBudgetState(MAX_PIPELINE_RETRIES + 1, plan.steps.length)

  for (let attempt = 0; attempt <= MAX_PIPELINE_RETRIES; attempt++) {
    if (ctx.signal?.aborted) {
      return { handled: true, answer: "Planner was cancelled.", plan }
    }

    ctx.onTrace?.({
      kind: PlannerTraceKind.PipelineStart,
      attempt: attempt + 1,
      verifierRound: verifierRounds,
      maxRetries: MAX_PIPELINE_RETRIES + 1
    })

    const callbacks = buildPipelineCallbacks(ctx, attempt)
    pipelineResult = await executePipeline(plan, ctx.tools as Tool[], effectiveDelegateFn, {
      maxParallel,
      workspaceRoot: ctx.workspaceRoot,
      priorResults: retryOpts.priorResults,
      repairPlan: retryOpts.repairPlan,
      runtimeModel,
      signal: ctx.signal,
      onStepStart: callbacks.onStepStart,
      onStepEnd: callbacks.onStepEnd
    })

    ctx.onTrace?.({
      kind: PlannerTraceKind.PipelineEnd,
      status: pipelineResult.status,
      completedSteps: pipelineResult.completedSteps,
      totalSteps: pipelineResult.totalSteps
    })

    const shortCircuit = tryPlatformUnconfiguredShortCircuit(ctx, plan, pipelineResult)
    if (shortCircuit) return shortCircuit

    const prevBudget = budgetState
    budgetState = maybeExtendBudget(budgetState, pipelineResult.completedSteps)
    if (budgetState.extensions > prevBudget.extensions) {
      ctx.onTrace?.({
        kind: PlannerTraceKind.BudgetExtended,
        completedSteps: pipelineResult.completedSteps,
        effectiveBudget: budgetState.effectiveBudget,
        extensions: budgetState.extensions
      })
    }

    verifierDecision = await verify(ctx.llm, plan, pipelineResult, ctx.tools as Tool[], {
      signal: ctx.signal,
      onTrace: ctx.onTrace
    })
    const computedRepairPlan = buildRepairPlan(plan, pipelineResult, verifierDecision)
    verifierDecision = { ...verifierDecision, repairPlan: computedRepairPlan }
    pipelineResult = applyVerificationAcceptanceStates(pipelineResult, verifierDecision)

    emitVerificationTraces(ctx, plan, pipelineResult, verifierDecision, decision.route, attempt, verifierRounds + 1)
    verifierRounds++

    if (verifierDecision.overall === VerifierOutcome.Pass) break

    ctx.onTrace?.({
      kind: PlannerTraceKind.RepairPlan,
      attempt: attempt + 1,
      epoch: attempt + 1,
      rerunOrder: computedRepairPlan.rerunOrder,
      tasks: computedRepairPlan.tasks.map((task) => ({
        stepName: task.stepName,
        mode: task.mode,
        ownedIssueCodes: task.ownedIssues.map((issue) => issue.code),
        dependencyIssueCodes: task.dependencyContext.map((issue) => issue.code)
      }))
    })

    const hasRetryableSteps = verifierDecision.steps.some(
      (s) => s.outcome !== VerifierOutcome.Pass && s.retryable !== false
    )

    let prelimAllStepsRepeatedFailure = true
    for (const stepAssessment of verifierDecision.steps) {
      if (stepAssessment.outcome === VerifierOutcome.Pass) continue
      const issueKey = buildIssueIdentity(stepAssessment)
      if (priorStepIssues.get(stepAssessment.stepName) !== issueKey) {
        prelimAllStepsRepeatedFailure = false
        break
      }
    }

    const escalation: EscalationDecision = resolveEscalation(
      buildEscalationInput({
        verifierOverall: verifierDecision.overall,
        attempt,
        maxAttempts: MAX_PIPELINE_RETRIES + 1,
        hasRetryableSteps,
        allStepsRepeatedFailure: prelimAllStepsRepeatedFailure
      })
    )

    ctx.onTrace?.({
      kind: PlannerTraceKind.Escalation,
      action: escalation.action,
      reason: escalation.reason,
      attempt: attempt + 1
    })

    if (escalation.action === "pass" || escalation.action === "escalate") break

    const regression = checkStubCountRegression({
      verifierDecision,
      pipelineResult,
      currentRepairPlan: computedRepairPlan,
      priorStepIssues,
      priorStubCounts,
      onTrace: ctx.onTrace
    })

    if (regression.forceReplanForFatalPattern) forceReplanForFatalPattern = true

    if (regression.allStepsRepeatedFailure && regression.retryableTaskCount === 0) {
      ctx.onTrace?.({
        kind: PlannerTraceKind.RetryAbort,
        reason: "All failing steps have repeated identical issues — aborting retries"
      })
      break
    }

    if (regression.shouldAbortRetriesForFatalPattern) break

    emitRetryTraces(ctx, attempt, verifierDecision, regression)
    retryOpts = { priorResults: regression.priorResults, repairPlan: regression.activeRepairPlan }
  }

  if (forceReplanForFatalPattern) {
    ctx.onTrace?.({
      kind: PlannerTraceKind.Escalation,
      action: "escalate",
      reason: "Forced replan after repeated fatal FUNCTION LOSS / contradictory completion pattern"
    })
  }

  return finalizePlannerRun(
    plan,
    pipelineResult!,
    verifierDecision!,
    banditTuner,
    banditTrajectory,
    pipelineStartMs
  )
}
