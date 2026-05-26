import { isPlannerRepairCompatibilityMode, PipelineStatus, PlannerRepairCompatibilityMode, PlannerTraceKind, VerifierOutcome } from "../../domain/index.js"
/**
 * Private helpers for the planner orchestrator.
 * @module
 */

import type { DelegationTrajectoryRecord } from "../../delegation/index.js"
import { detectPlatformUnconfigured } from "../platform-errors.js"
import { synthesizeAnswer } from "../synthesize.js"
import type { PipelineResult, Plan, VerifierDecision } from "../types.js"
import { deriveAcceptanceState } from "../verification-model/index.js"
import type { PlannerContext, PlannerResult } from "./types.js"

/**
 * If the pipeline failed because a platform integration (eg MSSQL) is
 * not configured, no retry can fix it — short-circuit with a user-safe
 * answer and emit operator-only diagnostics.
 */
export function tryPlatformUnconfiguredShortCircuit(
  ctx: PlannerContext,
  plan: Plan,
  pipelineResult: PipelineResult,
): PlannerResult | undefined {
  const platformUnconfiguredStep = [...pipelineResult.stepResults.values()]
    .find((r) => r.failureClass === "platform_unconfigured")
  if (!platformUnconfiguredStep) return undefined
  const hit = platformUnconfiguredStep.error
    ? detectPlatformUnconfigured(platformUnconfiguredStep.error)
    : null
  ctx.onTrace?.({
    kind: PlannerTraceKind.PlatformUnconfigured,
    stepName: platformUnconfiguredStep.name,
    subject: hit?.subject ?? "unknown integration",
    remediation: hit?.remediation ?? "Check server configuration.",
    rawError: platformUnconfiguredStep.error ?? "",
  })
  ctx.onTrace?.({
    kind: PlannerTraceKind.RetryAbort,
    reason: `Platform integration not configured (${platformUnconfiguredStep.name}) — no retry can repair operator-owned config`,
  })
  return {
    handled: true,
    answer: synthesizeAnswer(plan, pipelineResult, {
      overall: VerifierOutcome.Fail,
      confidence: 1,
      steps: [],
      systemChecks: [],
      unresolvedItems: [],
    }),
    plan,
  }
}

/**
 * Synthesise the final answer, record the bandit outcome, and shape the
 * structured PlannerResult (including the soft-fail skipReason when
 * verification didn't pass after all retries).
 */
export function finalizePlannerRun(
  plan: Plan,
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision,
  banditTuner: PlannerContext["delegationBanditTuner"] | undefined,
  banditTrajectory: DelegationTrajectoryRecord | undefined,
  pipelineStartMs: number,
): PlannerResult {
  const answer = synthesizeAnswer(plan, pipelineResult, verifierDecision)
  if (banditTuner && banditTrajectory) {
    const failedSteps = [...pipelineResult.stepResults.values()].filter(r => r.status === PipelineStatus.Failed).length
    const verifierPassed = verifierDecision.overall === VerifierOutcome.Pass
    const qualityProxy = verifierPassed
      ? verifierDecision.confidence
      : (verifierDecision.overall === VerifierOutcome.Retry ? 0.4 : 0.1)
    banditTuner.recordOutcome(banditTrajectory, {
      durationMs: Date.now() - pipelineStartMs,
      tokenCount: 0,
      errorCount: failedSteps,
      qualityProxy,
      verifierPassed,
    })
  }
  if (verifierDecision.overall !== VerifierOutcome.Pass) {
    return {
      handled: true,
      answer,
      plan,
      pipelineResult,
      verifierDecision,
      skipReason: "Verification failed after retries — structured execution halted",
    }
  }
  return { handled: true, answer, plan, pipelineResult, verifierDecision }
}

export function resolvePlannerCompatibilityMode(): PlannerRepairCompatibilityMode {
  const raw = (process.env["AGENT_PLANNER_COMPAT_MODE"] ?? PlannerRepairCompatibilityMode.Shadow).trim().toLowerCase()
  if (isPlannerRepairCompatibilityMode(raw)) return raw
  return PlannerRepairCompatibilityMode.Shadow
}

export function resolvePlannerCompatibilityThreshold(): number {
  const raw = Number(process.env["AGENT_PLANNER_COMPAT_THRESHOLD"] ?? 3)
  if (!Number.isFinite(raw)) return 3
  return Math.max(1, Math.floor(raw))
}

export function applyVerificationAcceptanceStates(
  pipelineResult: PipelineResult,
  verifierDecision: VerifierDecision,
): PipelineResult {
  const nextResults = new Map(pipelineResult.stepResults)

  for (const assessment of verifierDecision.steps) {
    const result = nextResults.get(assessment.stepName)
    if (!result) continue
    const hasBlueprintContractIssue = (assessment.issueDetails ?? []).some((issue) => issue.repairClass === "contract_drift" && /blueprint|spec/i.test(issue.summary))
    nextResults.set(assessment.stepName, {
      ...result,
      acceptanceState: deriveAcceptanceState(assessment, result.acceptanceState),
      failureClass: hasBlueprintContractIssue ? "blueprint_contract" : result.failureClass,
    })
  }

  return {
    ...pipelineResult,
    stepResults: nextResults,
  }
}

export function buildPlannerFailurePayload(params: {
  stage: "generation" | "validation" | "delegation"
  reason: string
  diagnostics?: readonly unknown[]
  score?: number
  plannerReason?: string
}): string {
  return JSON.stringify({
    kind: PlannerTraceKind.Failure,
    stage: params.stage,
    reason: params.reason,
    diagnostics: params.diagnostics ?? [],
    score: params.score ?? null,
    plannerReason: params.plannerReason ?? null,
    requiresDirectLoopFallback: false,
    action: "stop_and_request_plan_remediation",
  }, null, 2)
}
