import { PlannerRepairCompatibilityMode, PlannerTraceKind, VerifierOutcome } from "../../domain/index.js"
/**
 * Main planner orchestrator — executePlannerPath entry point.
 *
 * Calls runPlannerSetup (Steps 1–3b) then drives the pipeline retry loop
 * (Steps 4–5) and final synthesis (Step 6).
 * @module
 */

import {
  buildEscalationInput,
  resolveEscalation,
  type EscalationDecision
} from "../../../shell/delegation.js"
import type { Tool } from "../../types.js"
import { createBudgetState, maybeExtendBudget } from "../circuit-breaker.js"
import type { DelegateFn } from "../pipeline/index.js"
import { executePipeline } from "../pipeline/index.js"
import type { PipelineResult, RepairPlan, VerifierDecision } from "../types.js"
import {
  buildIssueIdentity,
  buildLegacyRetryPlan,
  buildRepairPlan,
  compareRepairPlanCompatibility
} from "../verification-model/index.js"
import { verify } from "../verifier/index.js"
import {
  applyVerificationAcceptanceStates,
  finalizePlannerRun,
  tryPlatformUnconfiguredShortCircuit
} from "./helpers.js"
import { checkStubCountRegression } from "./regression.js"
import { runPlannerSetup } from "./setup.js"
import {
  buildPipelineCallbacks,
  emitRepairPlanTraces,
  emitRetryTraces,
  emitVerificationTraces
} from "./traces.js"
import type { PlannerContext, PlannerResult } from "./types.js"

/**
 * Try to handle a task via the planner path.
 *
 * Returns { handled: true, answer } if the planner handled it,
 * or { handled: false, skipReason } if the task should go to the direct tool loop.
 *
 * Important: once a task is accepted into structured planning, unrepaired plan
 * validation failures are treated as terminal planner failures rather than
 * downgrading into the direct loop. Falling back after detecting an invalid
 * multi-step plan causes the exact overwrite regressions the validator exists
 * to prevent.
 *
 * @param options.forceRoute — skip routing assessment and force a specific planner
 *   route. Used by delay-commitment fallback when coherent generation fails.
 */
export async function executePlannerPath(
  goal: string,
  ctx: PlannerContext,
  delegateFn: DelegateFn,
  options?: { forceRoute?: "full_planner_decomposition" | "planner_with_coherent_bootstrap" }
): Promise<PlannerResult> {
  const MAX_PIPELINE_RETRIES = 2
  const pipelineStartMs = Date.now()
  const banditTuner = ctx.delegationBanditTuner

  // Steps 1–3b: routing, plan generation, validation, delegation gate
  const setupOutcome = await runPlannerSetup(goal, ctx, options)
  if (!setupOutcome.ready) return setupOutcome.result
  const { plan, runtimeModel, decision, banditTrajectory, compatibilityMode, compatibilityThreshold } =
    setupOutcome.context

  // Step 4: Execute pipeline with verifier loop (agenc-core pattern)
  // Track execution rounds and verifier rounds separately.
  // Verifier runs contract validation + deterministic probes each round.
  // Retry decisions are made by the escalation graph.
  let pipelineResult: PipelineResult | undefined
  let verifierDecision: VerifierDecision | undefined
  let legacyPinnedForRun = compatibilityMode === PlannerRepairCompatibilityMode.Legacy
  let retryOpts: {
    priorResults?: Map<string, import("../types.js").PipelineStepResult>
    repairPlan?: RepairPlan
  } = {}
  let verifierRounds = 0
  // Track issues per step across attempts to detect repeated identical failures
  const priorStepIssues = new Map<string, string>()
  // Track stub-issue count per step across attempts — if count doesn't decrease,
  // the child is stuck and further retries won't help
  const priorStubCounts = new Map<string, number>()
  // Repeated fatal failures should bypass additional retries and force replan.
  let forceReplanForFatalPattern = false

  // Pipeline budget tracking (planner/circuit-breaker) — monitor progress
  // across retry attempts and detect when further retries add no value
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
    pipelineResult = await executePipeline(plan, ctx.tools as Tool[], delegateFn, {
      maxParallel: 4,
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

    // Platform-unconfigured short-circuit. If any step failed because a
    // required platform integration is missing (e.g. MSSQL not configured),
    // there is nothing the verifier or repair loop can do — bypass
    // verification entirely and exit with a user-safe answer.
    const shortCircuit = tryPlatformUnconfiguredShortCircuit(ctx, plan, pipelineResult)
    if (shortCircuit) return shortCircuit

    // Update pipeline budget state — track progress for extension decisions
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

    // Step 5: Verify
    verifierDecision = await verify(ctx.llm, plan, pipelineResult, ctx.tools as Tool[], {
      signal: ctx.signal,
      onTrace: ctx.onTrace
    })
    const computedRepairPlan = buildRepairPlan(plan, pipelineResult, verifierDecision)
    verifierDecision = {
      ...verifierDecision,
      repairPlan: computedRepairPlan
    }
    const legacyRetryPlan = buildLegacyRetryPlan(plan, pipelineResult, verifierDecision)
    const repairCompatibility = compareRepairPlanCompatibility(
      compatibilityMode,
      legacyRetryPlan,
      computedRepairPlan
    )
    if (
      compatibilityMode === PlannerRepairCompatibilityMode.Shadow &&
      repairCompatibility.diverged &&
      repairCompatibility.divergenceScore >= compatibilityThreshold
    ) {
      legacyPinnedForRun = true
    }
    const activeCompatibilityPath: "legacy" | "repair" =
      compatibilityMode === PlannerRepairCompatibilityMode.Repair
        ? "repair"
        : legacyPinnedForRun
          ? "legacy"
          : "repair"
    pipelineResult = applyVerificationAcceptanceStates(pipelineResult, verifierDecision)

    emitVerificationTraces(
      ctx,
      plan,
      pipelineResult,
      verifierDecision,
      decision.route,
      attempt,
      verifierRounds + 1
    )

    verifierRounds++

    if (verifierDecision.overall === VerifierOutcome.Pass) {
      break
    }

    emitRepairPlanTraces(ctx, {
      attempt,
      verifierDecision,
      repairCompatibility,
      activeCompatibilityPath,
      compatibilityMode,
      legacyPinnedForRun,
      compatibilityThreshold
    })

    // agenc-core pattern: strict retry gating via escalation graph.
    // The escalation graph is a pure deterministic function that maps
    // the current state to a next action: pass/retry/revise/escalate.
    const hasRetryableSteps = verifierDecision.steps.some(
      (s) => s.outcome !== VerifierOutcome.Pass && s.retryable !== false
    )

    // Pre-compute: detect repeated identical failures for escalation input
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

    if (plan.coherentBootstrap && escalation.action === "escalate") {
      ctx.onTrace?.({
        kind: PlannerTraceKind.ArchitectureState,
        lane: plan.route ?? decision.route,
        status: "abandoned",
        reason: escalation.reason,
        architecture: plan.coherentBootstrap.architecture
      })
    }

    if (escalation.action === "pass" || escalation.action === "escalate") {
      break
    }

    // Build targeted retry context from verifier feedback
    const regression = checkStubCountRegression({
      verifierDecision,
      pipelineResult,
      currentRepairPlan: computedRepairPlan,
      activeCompatibilityPath,
      legacyRetryPlan,
      priorStepIssues,
      priorStubCounts,
      onTrace: ctx.onTrace
    })

    if (regression.forceReplanForFatalPattern) {
      forceReplanForFatalPattern = true
    }

    // If every failing step has repeated identical issues, stop retrying entirely
    if (regression.allStepsRepeatedFailure && regression.retryableTaskCount === 0) {
      ctx.onTrace?.({
        kind: PlannerTraceKind.RetryAbort,
        reason: "All failing steps have repeated identical issues — aborting retries"
      })
      break
    }

    if (regression.shouldAbortRetriesForFatalPattern) {
      break
    }

    emitRetryTraces(ctx, attempt, verifierDecision, regression)

    // Store retry context for next iteration
    retryOpts = { priorResults: regression.priorResults, repairPlan: regression.activeRepairPlan }
  }

  // Step 6: Synthesize final answer + record bandit outcome
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
