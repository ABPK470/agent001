import { PlannerTraceKind, VerifierOutcome } from "../../../domain/index.js"
/**
 * Stub-count regression tracking for the planner retry loop.
 *
 * @module
 */

import type {
  PipelineResult,
  PipelineStepResult,
  RepairPlan,
  VerifierDecision
} from "../types.js"
import { buildIssueIdentity } from "../verification-model/index.js"

export interface RegressionInput {
  readonly verifierDecision: VerifierDecision
  readonly pipelineResult: PipelineResult
  readonly currentRepairPlan: RepairPlan
  readonly priorStepIssues: Map<string, string>
  readonly priorStubCounts: Map<string, number>
  readonly onTrace?: (entry: Record<string, unknown>) => void
}

export interface RegressionResult {
  readonly priorResults: Map<string, PipelineStepResult>
  readonly activeRepairPlan: RepairPlan
  readonly allStepsRepeatedFailure: boolean
  readonly shouldAbortRetriesForFatalPattern: boolean
  readonly forceReplanForFatalPattern: boolean
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
  "empty function"
]

export function checkStubCountRegression(input: RegressionInput): RegressionResult {
  const {
    verifierDecision,
    pipelineResult,
    currentRepairPlan,
    priorStepIssues,
    priorStubCounts,
    onTrace
  } = input

  let allStepsRepeatedFailure = true
  let shouldAbortRetriesForFatalPattern = false
  let forceReplanForFatalPattern = false
  const priorResults = new Map<string, PipelineStepResult>()

  for (const stepAssessment of verifierDecision.steps) {
    const stepResult = pipelineResult.stepResults.get(stepAssessment.stepName)
    const issueKey = buildIssueIdentity(stepAssessment)
    const prevIssueKey = priorStepIssues.get(stepAssessment.stepName)
    const currentStubCount = stepAssessment.issues.filter((i) =>
      STUB_KEYWORDS.some((kw) => i.toLowerCase().includes(kw))
    ).length
    const prevStubCount = priorStubCounts.get(stepAssessment.stepName)
    const hasFatalPattern = stepAssessment.issues.some((i) =>
      /function loss|\[contract:contradictory_completion_claim\]|\[contract:unresolved_handoff_output\]/i.test(
        i
      )
    )

    if (stepAssessment.outcome === VerifierOutcome.Pass && stepResult) {
      priorResults.set(stepAssessment.stepName, stepResult)
      priorStepIssues.delete(stepAssessment.stepName)
      priorStubCounts.delete(stepAssessment.stepName)
    } else if (stepResult?.failureClass && NON_RETRYABLE_CLASSES.has(stepResult.failureClass)) {
      priorResults.set(stepAssessment.stepName, stepResult)
    } else if (stepAssessment.issues.length > 0) {
      const isExactRepeat = prevIssueKey === issueKey
      const stubsNotImproving =
        prevStubCount !== undefined && currentStubCount >= prevStubCount && currentStubCount > 0

      if (isExactRepeat || stubsNotImproving) {
        onTrace?.({
          kind: PlannerTraceKind.RetrySkip,
          stepName: stepAssessment.stepName,
          reason: isExactRepeat
            ? "Repeated identical failure — further retries won't help"
            : `Stub count not improving (${prevStubCount} → ${currentStubCount}) — child is stuck`
        })
        if (stepResult) priorResults.set(stepAssessment.stepName, stepResult)
      } else {
        allStepsRepeatedFailure = false
      }

      if (hasFatalPattern && isExactRepeat) {
        shouldAbortRetriesForFatalPattern = true
        forceReplanForFatalPattern = true
        onTrace?.({
          kind: PlannerTraceKind.RetryAbort,
          stepName: stepAssessment.stepName,
          reason:
            "Repeated fatal pattern detected (FUNCTION LOSS / contradictory completion claim) — aborting retries"
        })
      }

      priorStepIssues.set(stepAssessment.stepName, issueKey)
      priorStubCounts.set(stepAssessment.stepName, currentStubCount)
    } else {
      allStepsRepeatedFailure = false
    }
  }

  const retryableTaskCount = currentRepairPlan.tasks.filter((task) => task.mode !== "blocked").length

  return {
    priorResults,
    activeRepairPlan: currentRepairPlan,
    allStepsRepeatedFailure,
    shouldAbortRetriesForFatalPattern,
    forceReplanForFatalPattern,
    retryableTaskCount
  }
}
