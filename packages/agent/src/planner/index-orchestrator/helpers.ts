/**
 * Private helpers for the planner orchestrator.
 * @module
 */

import { synthesizeAnswer } from "../index-synthesize.js"
import { detectPlatformUnconfigured } from "../platform-errors.js"
import type { PipelineResult, Plan, PlannerRepairCompatibilityMode, VerifierDecision } from "../types.js"
import { deriveAcceptanceState } from "../verification-model.js"
import type { PlannerContext, PlannerResult } from "./types.js"
import type { DelegationTrajectoryRecord } from "../../delegation-learning.js"

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
    kind: "planner-platform-unconfigured",
    stepName: platformUnconfiguredStep.name,
    subject: hit?.subject ?? "unknown integration",
    remediation: hit?.remediation ?? "Check server configuration.",
    rawError: platformUnconfiguredStep.error ?? "",
  })
  ctx.onTrace?.({
    kind: "planner-retry-abort",
    reason: `Platform integration not configured (${platformUnconfiguredStep.name}) — no retry can repair operator-owned config`,
  })
  return {
    handled: true,
    answer: synthesizeAnswer(plan, pipelineResult, {
      overall: "fail",
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
    const failedSteps = [...pipelineResult.stepResults.values()].filter(r => r.status === "failed").length
    const verifierPassed = verifierDecision.overall === "pass"
    const qualityProxy = verifierPassed
      ? verifierDecision.confidence
      : (verifierDecision.overall === "retry" ? 0.4 : 0.1)
    banditTuner.recordOutcome(banditTrajectory, {
      durationMs: Date.now() - pipelineStartMs,
      tokenCount: 0,
      errorCount: failedSteps,
      qualityProxy,
      verifierPassed,
    })
  }
  if (verifierDecision.overall !== "pass") {
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
  const raw = (process.env["AGENT_PLANNER_COMPAT_MODE"] ?? "shadow").trim().toLowerCase()
  if (raw === "legacy" || raw === "repair" || raw === "shadow") return raw
  return "shadow"
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
    kind: "planner_failure",
    stage: params.stage,
    reason: params.reason,
    diagnostics: params.diagnostics ?? [],
    score: params.score ?? null,
    plannerReason: params.plannerReason ?? null,
    requiresDirectLoopFallback: false,
    action: "stop_and_request_plan_remediation",
  }, null, 2)
}
