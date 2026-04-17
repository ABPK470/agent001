/**
 * Main planner orchestrator — executePlannerPath entry point.
 *
 * Calls runPlannerSetup (Steps 1–3b) then drives the pipeline retry loop
 * (Steps 4–5) and final synthesis (Step 6).
 * @module
 */

import { buildEscalationInput, resolveEscalation, type EscalationDecision } from "../../escalation.js"
import type { Tool } from "../../types.js"
import { createBudgetState, maybeExtendBudget } from "../circuit-breaker.js"
import { synthesizeAnswer } from "../index-synthesize.js"
import type { DelegateFn } from "../pipeline.js"
import { executePipeline } from "../pipeline.js"
import type { PipelineResult, RepairPlan, VerifierDecision } from "../types.js"
import { buildIssueIdentity, buildLegacyRetryPlan, buildRepairPlan, compareRepairPlanCompatibility } from "../verification-model.js"
import { verify } from "../verifier.js"
import { applyVerificationAcceptanceStates } from "./helpers.js"
import { checkStubCountRegression } from "./regression.js"
import { runPlannerSetup } from "./setup.js"
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
  options?: { forceRoute?: "full_planner_decomposition" | "planner_with_coherent_bootstrap" },
): Promise<PlannerResult> {
  const MAX_PIPELINE_RETRIES = 2
  const pipelineStartMs = Date.now()
  const banditTuner = ctx.delegationBanditTuner

  // Steps 1–3b: routing, plan generation, validation, delegation gate
  const setupOutcome = await runPlannerSetup(goal, ctx, options)
  if (!setupOutcome.ready) return setupOutcome.result
  const { plan, runtimeModel, decision, banditTrajectory, compatibilityMode, compatibilityThreshold } = setupOutcome.context

  // Step 4: Execute pipeline with verifier loop (agenc-core pattern)
  // Track execution rounds and verifier rounds separately.
  // Verifier runs contract validation + deterministic probes each round.
  // Retry decisions are made by the escalation graph.
  let pipelineResult: PipelineResult | undefined
  let verifierDecision: VerifierDecision | undefined
  let legacyPinnedForRun = compatibilityMode === "legacy"
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
      kind: "planner-pipeline-start",
      attempt: attempt + 1,
      verifierRound: verifierRounds,
      maxRetries: MAX_PIPELINE_RETRIES + 1,
    })

    pipelineResult = await executePipeline(
      plan,
      ctx.tools as Tool[],
      delegateFn,
      {
        maxParallel: 4,
        workspaceRoot: ctx.workspaceRoot,
        priorResults: retryOpts.priorResults,
        repairPlan: retryOpts.repairPlan,
        runtimeModel,
        signal: ctx.signal,
        onStepStart: (step) => ctx.onTrace?.({
          kind: "planner-step-start",
          stepName: step.name,
          stepType: step.stepType,
        }),
        onStepEnd: (step, result) => {
          ctx.onTrace?.({
            kind: "planner-step-end",
            stepName: step.name,
            status: result.status,
            executionState: result.executionState,
            acceptanceState: result.acceptanceState,
            durationMs: result.durationMs,
            error: result.error,
            validationCode: result.validationCode,
            producedArtifacts: result.producedArtifacts,
            verificationAttempts: result.verificationAttempts,
            reconciliation: result.reconciliation
              ? {
                  compliant: result.reconciliation.compliant,
                  findings: result.reconciliation.findings.map((finding) => ({
                    code: finding.code,
                    severity: finding.severity,
                    message: finding.message,
                  })),
                }
              : undefined,
          })
          ctx.onTrace?.({
            kind: "planner-step-transition",
            attempt: attempt + 1,
            stepName: step.name,
            phase: "execution",
            state: result.acceptanceState ?? result.status,
            timestamp: Date.now(),
          })
        },
      },
    )

    ctx.onTrace?.({
      kind: "planner-pipeline-end",
      status: pipelineResult.status,
      completedSteps: pipelineResult.completedSteps,
      totalSteps: pipelineResult.totalSteps,
    })

    // Update pipeline budget state — track progress for extension decisions
    const prevBudget = budgetState
    budgetState = maybeExtendBudget(budgetState, pipelineResult.completedSteps)
    if (budgetState.extensions > prevBudget.extensions) {
      ctx.onTrace?.({
        kind: "planner-budget-extended",
        completedSteps: pipelineResult.completedSteps,
        effectiveBudget: budgetState.effectiveBudget,
        extensions: budgetState.extensions,
      })
    }

    // Step 5: Verify
    verifierDecision = await verify(
      ctx.llm,
      plan,
      pipelineResult,
      ctx.tools as Tool[],
      { signal: ctx.signal, onTrace: ctx.onTrace },
    )
    const computedRepairPlan = buildRepairPlan(plan, pipelineResult, verifierDecision)
    verifierDecision = {
      ...verifierDecision,
      repairPlan: computedRepairPlan,
    }
    const legacyRetryPlan = buildLegacyRetryPlan(plan, pipelineResult, verifierDecision)
    const repairCompatibility = compareRepairPlanCompatibility(
      compatibilityMode,
      legacyRetryPlan,
      computedRepairPlan,
    )
    if (
      compatibilityMode === "shadow"
      && repairCompatibility.diverged
      && repairCompatibility.divergenceScore >= compatibilityThreshold
    ) {
      legacyPinnedForRun = true
    }
    const activeCompatibilityPath: "legacy" | "repair" = compatibilityMode === "repair"
      ? "repair"
      : legacyPinnedForRun
        ? "legacy"
        : "repair"
    pipelineResult = applyVerificationAcceptanceStates(pipelineResult, verifierDecision)

    ctx.onTrace?.({
      kind: "planner-verification",
      overall: verifierDecision.overall,
      confidence: verifierDecision.confidence,
      verifierRound: verifierRounds + 1,
      systemChecks: verifierDecision.systemChecks?.map((check) => ({
        code: check.code,
        severity: check.severity,
        summary: check.summary,
        confidence: check.confidence,
      })),
      steps: verifierDecision.steps.map(s => ({
        stepName: s.stepName,
        outcome: s.outcome,
        issues: s.issues,
        issueCodes: s.issueDetails?.map(issue => issue.code) ?? [],
        ownershipModes: s.issueDetails?.map(issue => issue.ownershipMode) ?? [],
        issueConfidences: s.issueDetails?.map(issue => issue.confidence) ?? [],
        acceptanceState: pipelineResult?.stepResults.get(s.stepName)?.acceptanceState,
      })),
    })
    if (plan.coherentBootstrap) {
      ctx.onTrace?.({
        kind: "planner-architecture-state",
        lane: plan.route ?? decision.route,
        status: verifierDecision.overall === "pass" ? "preserved" : "repairing_in_place",
        reason: verifierDecision.overall === "pass" ? "verification_passed" : "architecture_preserving_repair",
        architecture: plan.coherentBootstrap.architecture,
      })
    }
    ctx.onTrace?.({
      kind: "planner-issue-timeline",
      attempt: attempt + 1,
      verifierRound: verifierRounds + 1,
      issues: verifierDecision.steps.flatMap((step) => (step.issueDetails ?? []).map((issue) => ({
        stepName: step.stepName,
        code: issue.code,
        confidence: issue.confidence,
        ownershipMode: issue.ownershipMode,
        primaryOwner: issue.primaryOwner,
        suspectedOwners: [...issue.suspectedOwners],
      }))),
    })
    for (const step of verifierDecision.steps) {
      ctx.onTrace?.({
        kind: "planner-step-transition",
        attempt: attempt + 1,
        stepName: step.stepName,
        phase: "verification",
        state: pipelineResult?.stepResults.get(step.stepName)?.acceptanceState ?? step.outcome,
        timestamp: Date.now(),
      })
    }
    ctx.onTrace?.({
      kind: "planner-repair-plan",
      attempt: attempt + 1,
      epoch: attempt + 1,
      rerunOrder: verifierDecision.repairPlan?.rerunOrder ?? [],
      tasks: verifierDecision.repairPlan?.tasks.map(task => ({
        stepName: task.stepName,
        mode: task.mode,
        ownedIssueCodes: task.ownedIssues.map(issue => issue.code),
        dependencyIssueCodes: task.dependencyContext.map(issue => issue.code),
      })) ?? [],
    })
    ctx.onTrace?.({
      kind: "planner-repair-compatibility",
      attempt: attempt + 1,
      mode: repairCompatibility.mode,
      activePath: activeCompatibilityPath,
      diverged: repairCompatibility.diverged,
      divergenceScore: repairCompatibility.divergenceScore,
      divergenceThreshold: compatibilityThreshold,
      pinnedToLegacy: compatibilityMode === "shadow" && legacyPinnedForRun,
      reasons: [...repairCompatibility.reasons],
      legacy: {
        rerunOrder: repairCompatibility.legacyPlan.rerunOrder,
        tasks: repairCompatibility.legacyPlan.tasks.map((task) => ({
          stepName: task.stepName,
          mode: task.mode,
          ownedIssueCodes: task.ownedIssues.map((issue) => issue.code),
        })),
      },
      repair: {
        rerunOrder: repairCompatibility.repairPlan.rerunOrder,
        tasks: repairCompatibility.repairPlan.tasks.map((task) => ({
          stepName: task.stepName,
          mode: task.mode,
          ownedIssueCodes: task.ownedIssues.map((issue) => issue.code),
          dependencyIssueCodes: task.dependencyContext.map((issue) => issue.code),
        })),
      },
    })

    verifierRounds++

    if (verifierDecision.overall === "pass") {
      break
    }

    // agenc-core pattern: strict retry gating via escalation graph.
    // The escalation graph is a pure deterministic function that maps
    // the current state to a next action: pass/retry/revise/escalate.
    const hasRetryableSteps = verifierDecision.steps.some(
      s => s.outcome !== "pass" && s.retryable !== false,
    )

    // Pre-compute: detect repeated identical failures for escalation input
    let prelimAllStepsRepeatedFailure = true
    for (const stepAssessment of verifierDecision.steps) {
      if (stepAssessment.outcome === "pass") continue
      const issueKey = buildIssueIdentity(stepAssessment)
      if (priorStepIssues.get(stepAssessment.stepName) !== issueKey) {
        prelimAllStepsRepeatedFailure = false
        break
      }
    }

    const escalation: EscalationDecision = resolveEscalation(buildEscalationInput({
      verifierOverall: verifierDecision.overall,
      attempt,
      maxAttempts: MAX_PIPELINE_RETRIES + 1,
      hasRetryableSteps,
      allStepsRepeatedFailure: prelimAllStepsRepeatedFailure,
    }))

    ctx.onTrace?.({
      kind: "planner-escalation",
      action: escalation.action,
      reason: escalation.reason,
      attempt: attempt + 1,
    })

    if (plan.coherentBootstrap && escalation.action === "escalate") {
      ctx.onTrace?.({
        kind: "planner-architecture-state",
        lane: plan.route ?? decision.route,
        status: "abandoned",
        reason: escalation.reason,
        architecture: plan.coherentBootstrap.architecture,
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
      onTrace: ctx.onTrace,
    })

    if (regression.forceReplanForFatalPattern) {
      forceReplanForFatalPattern = true
    }

    // If every failing step has repeated identical issues, stop retrying entirely
    if (regression.allStepsRepeatedFailure && regression.retryableTaskCount === 0) {
      ctx.onTrace?.({
        kind: "planner-retry-abort",
        reason: "All failing steps have repeated identical issues — aborting retries",
      })
      break
    }

    if (regression.shouldAbortRetriesForFatalPattern) {
      break
    }

    ctx.onTrace?.({
      kind: "planner-retry",
      attempt: attempt + 1,
      reason: verifierDecision.unresolvedItems.join("; "),
      skippedSteps: regression.priorResults.size,
      retrySteps: regression.retryableTaskCount,
      rerunOrder: regression.activeRepairPlan.rerunOrder,
    })
    for (const task of regression.activeRepairPlan.tasks) {
      ctx.onTrace?.({
        kind: "planner-step-transition",
        attempt: attempt + 1,
        stepName: task.stepName,
        phase: "repair",
        state: task.mode,
        timestamp: Date.now(),
      })
    }

    // Store retry context for next iteration
    retryOpts = { priorResults: regression.priorResults, repairPlan: regression.activeRepairPlan }
  }

  // Step 6: Synthesize final answer
  if (forceReplanForFatalPattern) {
    ctx.onTrace?.({
      kind: "planner-escalation",
      action: "escalate",
      reason: "Forced replan after repeated fatal FUNCTION LOSS / contradictory completion pattern",
    })
  }

  const answer = synthesizeAnswer(plan, pipelineResult!, verifierDecision!)

  // Record bandit outcome now that we have a verifier decision and final pipeline state
  if (banditTuner && banditTrajectory) {
    const failedSteps = [...pipelineResult!.stepResults.values()].filter(r => r.status === "failed").length
    const verifierPassed = verifierDecision!.overall === "pass"
    const qualityProxy = verifierPassed ? verifierDecision!.confidence : (verifierDecision!.overall === "partial" ? 0.4 : 0.1)
    banditTuner.recordOutcome(banditTrajectory, {
      durationMs: Date.now() - pipelineStartMs,
      tokenCount: 0,  // not available at this layer
      errorCount: failedSteps,
      qualityProxy,
      verifierPassed,
    })
  }

  // Contract-governed-first behavior: if verification didn't pass after all
  // retries, DO NOT fall through to the unstructured direct tool loop.
  // Return a structured failure response and keep remediation in planner mode.
  if (verifierDecision!.overall !== "pass") {
    return {
      handled: true,
      answer,
      plan,
      pipelineResult,
      verifierDecision,
      skipReason: "Verification failed after retries — structured execution halted",
    }
  }

  return {
    handled: true,
    answer,
    plan,
    pipelineResult,
    verifierDecision,
  }
}
