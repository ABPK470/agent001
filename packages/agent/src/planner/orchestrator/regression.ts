import { PlannerTraceKind, VerifierOutcome } from "@mia/agent"
/**
 * Stub-count regression tracking for the planner retry loop.
 *
 * Detects repeated identical failures and stub-count stagnation across retry
 * attempts so the orchestrator can abort fruitless retries early.
 * @module
 */

import type { LegacyRetryPlan, PipelineResult, PipelineStepResult, RepairPlan, VerifierDecision } from "../types.js"
import { buildIssueIdentity } from "../verification-model/index.js"

export interface RegressionInput {
  readonly verifierDecision: VerifierDecision
  readonly pipelineResult: PipelineResult
  /** The current repair plan (verifierDecision.repairPlan, already computed by the loop). */
  readonly currentRepairPlan: RepairPlan
  readonly activeCompatibilityPath: "legacy" | "repair"
  readonly legacyRetryPlan: LegacyRetryPlan
  /** Mutable: updated in place with this iteration's issue fingerprints. */
  readonly priorStepIssues: Map<string, string>
  /** Mutable: updated in place with this iteration's stub-issue counts. */
  readonly priorStubCounts: Map<string, number>
  readonly onTrace?: (entry: Record<string, unknown>) => void
}

export interface RegressionResult {
  /** Accumulated prior results for the next pipeline pass. */
  readonly priorResults: Map<string, PipelineStepResult>
  /** The repair plan selected for the next iteration. */
  readonly activeRepairPlan: RepairPlan
  /** True when every failing step produced the same issues as last attempt. */
  readonly allStepsRepeatedFailure: boolean
  /** True when a fatal repeated pattern was detected (abort retries + force replan). */
  readonly shouldAbortRetriesForFatalPattern: boolean
  /** Whether the outer forceReplanForFatalPattern flag should be set to true. */
  readonly forceReplanForFatalPattern: boolean
  /** Number of non-blocked tasks in the active repair plan. */
  readonly retryableTaskCount: number
}

const NON_RETRYABLE_CLASSES = new Set(["cancelled", "spawn_error"])

const STUB_KEYWORDS = [
  "stub",
  "placeholder",
  "empty array",
  "empty object",
  "returns constant",
  "catch-all",
  "trivial return",
  "empty function",
]

/**
 * Run stub-count regression tracking for one retry iteration.
 * Mutates priorStepIssues and priorStubCounts in place.
 */
export function checkStubCountRegression(input: RegressionInput): RegressionResult {
  const { verifierDecision, pipelineResult, currentRepairPlan, activeCompatibilityPath, legacyRetryPlan, priorStepIssues, priorStubCounts, onTrace } = input

  const activeRepairPlan = activeCompatibilityPath === "legacy"
    ? {
        tasks: legacyRetryPlan.tasks,
        rerunOrder: legacyRetryPlan.rerunOrder,
        skippedVerifiedSteps: legacyRetryPlan.skippedVerifiedSteps,
      }
    : currentRepairPlan

  // Detect repeated identical failures — if a step produces the same issues
  // as the previous attempt, further retries won't help (LLM is stuck).
  let allStepsRepeatedFailure = true
  let shouldAbortRetriesForFatalPattern = false
  let forceReplanForFatalPattern = false
  const priorResults = new Map<string, PipelineStepResult>()

  for (const stepAssessment of verifierDecision.steps) {
    const stepResult = pipelineResult.stepResults.get(stepAssessment.stepName)

    // Check if this step's issues are identical to the previous attempt
    const issueKey = buildIssueIdentity(stepAssessment)
    const prevIssueKey = priorStepIssues.get(stepAssessment.stepName)

    // Count stub-specific issues for regression tracking
    const currentStubCount = stepAssessment.issues.filter(i =>
      STUB_KEYWORDS.some(kw => i.toLowerCase().includes(kw)),
    ).length
    const prevStubCount = priorStubCounts.get(stepAssessment.stepName)
    const hasFatalPattern = stepAssessment.issues.some(i =>
      /function loss|\[contract:contradictory_completion_claim\]|\[contract:unresolved_handoff_output\]/i.test(i),
    )

    if (stepAssessment.outcome === VerifierOutcome.Pass && stepResult) {
      priorResults.set(stepAssessment.stepName, stepResult)
      priorStepIssues.delete(stepAssessment.stepName)
      priorStubCounts.delete(stepAssessment.stepName)
    } else if (stepResult?.failureClass && NON_RETRYABLE_CLASSES.has(stepResult.failureClass)) {
      priorResults.set(stepAssessment.stepName, stepResult)
    } else if (stepAssessment.issues.length > 0) {
      // Check for repeated failure OR stub-count not improving
      const isExactRepeat = prevIssueKey === issueKey
      const stubsNotImproving = prevStubCount !== undefined && currentStubCount >= prevStubCount && currentStubCount > 0

      if (isExactRepeat || stubsNotImproving) {
        onTrace?.({
          kind: PlannerTraceKind.RetrySkip,
          stepName: stepAssessment.stepName,
          reason: isExactRepeat
            ? "Repeated identical failure — further retries won't help"
            : `Stub count not improving (${prevStubCount} → ${currentStubCount}) — child is stuck`,
        })
        if (stepResult) {
          priorResults.set(stepAssessment.stepName, stepResult)
        }
      } else {
        allStepsRepeatedFailure = false
      }

      if (hasFatalPattern && isExactRepeat) {
        shouldAbortRetriesForFatalPattern = true
        forceReplanForFatalPattern = true
        onTrace?.({
          kind: PlannerTraceKind.RetryAbort,
          stepName: stepAssessment.stepName,
          reason: "Repeated fatal pattern detected (FUNCTION LOSS / contradictory completion claim) — aborting retries and forcing replan",
        })
      }

      priorStepIssues.set(stepAssessment.stepName, issueKey)
      priorStubCounts.set(stepAssessment.stepName, currentStubCount)
    } else {
      allStepsRepeatedFailure = false
    }
  }

  const retryableTaskCount = activeRepairPlan.tasks.filter((task) => task.mode !== "blocked").length

  return {
    priorResults,
    activeRepairPlan,
    allStepsRepeatedFailure,
    shouldAbortRetriesForFatalPattern,
    forceReplanForFatalPattern,
    retryableTaskCount,
  }
}
