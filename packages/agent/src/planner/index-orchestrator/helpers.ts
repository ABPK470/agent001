/**
 * Private helpers for the planner orchestrator.
 * @module
 */

import type { PipelineResult, PlannerRepairCompatibilityMode, VerifierDecision } from "../types.js"
import { deriveAcceptanceState } from "../verification-model.js"

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
