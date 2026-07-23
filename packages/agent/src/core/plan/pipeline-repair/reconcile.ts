import { DiagnosticSeverity, EffectClass, PipelineBlockCode } from "../../../domain/index.js"
/**
 * Repair plan helpers, reconciliation, and blueprint retry guidance.
 *
 * @module
 */

import type {
  ContractReconciliationFinding,
  PipelineStepResult,
  PlannerRuntimeModel,
  RepairPlan,
  RepairTask,
  SubagentTaskStep
} from "../types.js"
import { buildIssueRepairActions, buildLanguageRepairGuidance, detectArtifactFamilies } from "./artifacts.js"

// ============================================================================
// Repair plan helpers
// ============================================================================

export function collectAcceptedArtifacts(
  priorResults: ReadonlyMap<string, PipelineStepResult> | undefined,
  stepResults: ReadonlyMap<string, PipelineStepResult>
): Set<string> {
  const accepted = new Set<string>()
  const append = (result: PipelineStepResult | undefined) => {
    if (!result || result.acceptanceState !== "accepted") return
    for (const artifact of result.producedArtifacts ?? []) accepted.add(artifact)
    for (const artifact of result.modifiedArtifacts ?? []) accepted.add(artifact)
  }
  if (priorResults) {
    for (const result of priorResults.values()) append(result)
  }
  for (const result of stepResults.values()) append(result)
  return accepted
}

/**
 * Artifacts safe for same-pass DAG handoffs: completed steps that either
 * already passed verify (`accepted`) or finished execution and await verify
 * (`pending_verification`). Without this, dependents wait forever because
 * verify only runs AFTER the full pipeline pass.
 */
export function collectRunnableUpstreamArtifacts(
  priorResults: ReadonlyMap<string, PipelineStepResult> | undefined,
  stepResults: ReadonlyMap<string, PipelineStepResult>
): Set<string> {
  const runnable = new Set<string>()
  const append = (result: PipelineStepResult | undefined) => {
    if (!result || result.status !== "completed") return
    if (
      result.acceptanceState !== "accepted" &&
      result.acceptanceState !== "pending_verification"
    ) {
      return
    }
    for (const artifact of result.producedArtifacts ?? []) runnable.add(artifact)
    for (const artifact of result.modifiedArtifacts ?? []) runnable.add(artifact)
  }
  if (priorResults) {
    for (const result of priorResults.values()) append(result)
  }
  for (const result of stepResults.values()) append(result)
  return runnable
}

function artifactSatisfied(required: string, available: ReadonlySet<string>): boolean {
  if (available.has(required)) return true
  const requiredBase = required.split("/").pop() ?? required
  for (const candidate of available) {
    if ((candidate.split("/").pop() ?? candidate) === requiredBase) return true
  }
  return false
}

export function getRepairTaskForStep(
  repairPlan: RepairPlan | undefined,
  stepName: string
): RepairTask | undefined {
  return repairPlan?.tasks.find((task) => task.stepName === stepName)
}

export function getUnresolvedAcceptanceBlockers(
  stepName: string,
  runtimeModel: PlannerRuntimeModel,
  repairTask: RepairTask | undefined,
  acceptedArtifacts: ReadonlySet<string>,
  runnableArtifacts: ReadonlySet<string> = acceptedArtifacts
): string[] {
  // Repair payloads may demand verifier-accepted inputs (post-verify epoch).
  const repairRequired = new Set<string>(repairTask?.requiredAcceptedArtifacts ?? [])
  // Normal DAG read deps only need upstream to have produced the file this epoch.
  const handoffRequired = new Set<string>()
  const acceptedDependencySteps = runtimeModel.stepAcceptedDependencies.get(stepName) ?? []

  for (const dependencyStepName of acceptedDependencySteps) {
    const dependencyArtifacts = [...runtimeModel.ownershipGraph.values()]
      .filter((artifact) => artifact.ownerStepName === dependencyStepName)
      .map((artifact) => artifact.artifactPath)
    for (const artifact of dependencyArtifacts) handoffRequired.add(artifact)
  }

  const missing: string[] = []
  for (const artifact of repairRequired) {
    if (!artifactSatisfied(artifact, acceptedArtifacts)) missing.push(artifact)
  }
  for (const artifact of handoffRequired) {
    if (repairRequired.has(artifact)) continue
    if (
      artifactSatisfied(artifact, runnableArtifacts) ||
      artifactSatisfied(artifact, acceptedArtifacts)
    ) {
      continue
    }
    missing.push(artifact)
  }
  return missing
}

export function buildAutonomousRepairBlock(step: SubagentTaskStep, feedback: readonly string[]): string {
  const actions = buildIssueRepairActions(step, feedback)
  const languageGuidance = buildLanguageRepairGuidance(
    detectArtifactFamilies(step.executionContext.targetArtifacts)
  )
  if (actions.length === 0 && languageGuidance.length === 0) return ""

  const lines = [
    "",
    "AUTONOMOUS REPAIR PLAN — treat verifier findings as ground truth and fix them without asking for human clarification:",
    ...actions.map((action, index) => `${index + 1}. ${action}`),
    ...(languageGuidance.length > 0
      ? [
          "",
          "LANGUAGE-SPECIFIC EXECUTION RULES:",
          ...languageGuidance.map((rule, index) => `${index + 1}. ${rule}`)
        ]
      : [])
  ]

  return `\n\n${lines.join("\n")}`
}

export function summarizeRepairTask(task: RepairTask): { primary: string[]; reference: string[] } {
  return {
    primary: task.ownedIssues.map((issue) => issue.summary),
    reference: task.dependencyContext.map((issue) => issue.summary)
  }
}

import { normalizeToolCallPath } from "./path-normalize.js"

export { normalizeToolCallPath } from "./path-normalize.js"

// ============================================================================
// Tool call path normalization + artifact collection
// ============================================================================

export function collectReportedArtifacts(stepResult: PipelineStepResult): Set<string> {
  const artifacts = new Set<string>()
  for (const artifact of stepResult.producedArtifacts ?? []) artifacts.add(normalizeToolCallPath(artifact))
  for (const artifact of stepResult.modifiedArtifacts ?? []) artifacts.add(normalizeToolCallPath(artifact))
  for (const call of stepResult.toolCalls ?? []) {
    const path = normalizeToolCallPath(call.args.path)
    if (!path) continue
    if (call.name === "write_file" || call.name === "replace_in_file" || call.name === "append_file") {
      artifacts.add(path)
    }
  }
  return artifacts
}

// ============================================================================
// Post-execution reconciliation
// ============================================================================

export function applyPostExecutionReconciliation(
  step: SubagentTaskStep,
  stepResult: PipelineStepResult
): PipelineStepResult {
  if (stepResult.toolCalls == null && stepResult.childResult == null) return stepResult

  const findings: ContractReconciliationFinding[] = []
  const reportedArtifacts = collectReportedArtifacts(stepResult)
  const targetArtifacts = new Set(step.executionContext.targetArtifacts.map(normalizeToolCallPath))
  const sourceArtifacts = new Set(step.executionContext.requiredSourceArtifacts.map(normalizeToolCallPath))
  const forbiddenArtifacts = new Set(
    (step.executionContext.forbiddenArtifacts ?? []).map(normalizeToolCallPath)
  )

  const forbiddenTouched = [...reportedArtifacts].filter((artifact) => forbiddenArtifacts.has(artifact))
  if (forbiddenTouched.length > 0) {
    findings.push({
      code: PipelineBlockCode.ForbiddenArtifactWrite,
      severity: DiagnosticSeverity.Error,
      message: `Step modified forbidden artifacts: ${forbiddenTouched.join(", ")}`,
      artifactPaths: forbiddenTouched
    })
  }

  // Skip missing-output check when the child explicitly reported success with no blockers:
  // the target artifacts were already produced in a prior attempt and remain on disk.
  const childAlreadySatisfied =
    stepResult.childResult?.status === "success" &&
    (stepResult.childResult.unresolvedBlockers.length ?? 0) === 0
  const missingOutputs =
    step.executionContext.effectClass !== EffectClass.Readonly && !childAlreadySatisfied
      ? [...targetArtifacts].filter((artifact) => !reportedArtifacts.has(artifact))
      : []
  if (missingOutputs.length > 0) {
    findings.push({
      code: PipelineBlockCode.MissingRequiredOutput,
      severity: DiagnosticSeverity.Error,
      message: `Step did not produce or modify all required target artifacts: ${missingOutputs.join(", ")}`,
      artifactPaths: missingOutputs
    })
  }

  const hallucinatedArtifacts = [...reportedArtifacts].filter(
    (artifact) => !targetArtifacts.has(artifact) && !sourceArtifacts.has(artifact)
  )
  if (hallucinatedArtifacts.length > 0) {
    findings.push({
      code: PipelineBlockCode.HallucinatedArtifact,
      severity: DiagnosticSeverity.Error,
      message: `Step reported mutations to artifacts outside its contract: ${hallucinatedArtifacts.join(", ")}`,
      artifactPaths: hallucinatedArtifacts
    })
  }

  if ((stepResult.childResult?.unresolvedBlockers.length ?? 0) > 0) {
    findings.push({
      code: PipelineBlockCode.UnresolvedBlocker,
      severity: DiagnosticSeverity.Error,
      message: `Step reported unresolved blockers: ${stepResult.childResult!.unresolvedBlockers.join("; ")}`,
      artifactPaths: []
    })
  }

  if (
    (step.executionContext.requiredChecks?.length ?? 0) > 0 &&
    (stepResult.verificationAttempts?.length ?? 0) === 0
  ) {
    findings.push({
      code: PipelineBlockCode.RequiredCheckSkipped,
      severity: DiagnosticSeverity.Warning,
      message: "Step completed without recording any verification attempts for its required checks.",
      artifactPaths: []
    })
  }

  if (findings.length === 0) {
    return {
      ...stepResult,
      reconciliation: {
        compliant: true,
        findings: []
      }
    }
  }

  const hasErrors = findings.some((finding: ContractReconciliationFinding) => finding.severity === "error")
  if (!hasErrors) {
    return {
      ...stepResult,
      reconciliation: {
        compliant: true,
        findings
      }
    }
  }

  return {
    ...stepResult,
    status: "failed",
    executionState: "failed",
    acceptanceState: "repair_required",
    error: [
      stepResult.error,
      ...findings
        .filter((finding: ContractReconciliationFinding) => finding.severity === "error")
        .map((finding: ContractReconciliationFinding) => finding.message)
    ]
      .filter(Boolean)
      .join("\n"),
    reconciliation: {
      compliant: false,
      findings
    }
  }
}

// ============================================================================
// Blueprint retry / validation lives in pipeline-repair/blueprint.ts
// ============================================================================

export {
  buildBlueprintRetryGuidance,
  executeToolForText,
  hasSuccessfulReadBackAfterWrite,
  isBlueprintLikeStep,
  validateBlueprintStepCompletion
} from "./blueprint.js"
export type { SubagentValidationFailure } from "./blueprint.js"
