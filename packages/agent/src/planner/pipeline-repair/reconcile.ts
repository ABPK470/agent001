/**
 * Repair plan helpers, reconciliation, and blueprint retry guidance.
 *
 * @module
 */

import type { ToolCallRecord } from "../../recovery.js"
import { normalizeToolExecutionOutput } from "../../tool-utils.js"
import type { Tool } from "../../types.js"
import {
    buildBlueprintSeedTemplate,
    getPlannedBlueprintArtifacts,
    validateBlueprintArtifactContract,
} from "../blueprint-contract.js"
import type {
    ContractReconciliationFinding,
    PipelineStepResult,
    Plan,
    PlannerRuntimeModel,
    RepairPlan,
    RepairTask,
    SubagentTaskStep,
} from "../types.js"
import {
    type SubagentStepValidationContext,
    buildIssueRepairActions,
    buildLanguageRepairGuidance,
    detectArtifactFamilies,
} from "./artifacts.js"

// ============================================================================
// Repair plan helpers
// ============================================================================

export function collectAcceptedArtifacts(
  priorResults: ReadonlyMap<string, PipelineStepResult> | undefined,
  stepResults: ReadonlyMap<string, PipelineStepResult>,
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

export function getRepairTaskForStep(repairPlan: RepairPlan | undefined, stepName: string): RepairTask | undefined {
  return repairPlan?.tasks.find((task) => task.stepName === stepName)
}

export function getUnresolvedAcceptanceBlockers(
  stepName: string,
  runtimeModel: PlannerRuntimeModel,
  repairTask: RepairTask | undefined,
  acceptedArtifacts: ReadonlySet<string>,
): string[] {
  const requiredAcceptedArtifacts = new Set<string>(repairTask?.requiredAcceptedArtifacts ?? [])
  const acceptedDependencySteps = runtimeModel.stepAcceptedDependencies.get(stepName) ?? []

  for (const dependencyStepName of acceptedDependencySteps) {
    const dependencyArtifacts = [...runtimeModel.ownershipGraph.values()]
      .filter((artifact) => artifact.ownerStepName === dependencyStepName)
      .map((artifact) => artifact.artifactPath)
    for (const artifact of dependencyArtifacts) requiredAcceptedArtifacts.add(artifact)
  }

  return [...requiredAcceptedArtifacts].filter((artifact) => {
    if (acceptedArtifacts.has(artifact)) return false
    const artBase = artifact.split("/").pop() ?? artifact
    for (const accepted of acceptedArtifacts) {
      if ((accepted.split("/").pop() ?? accepted) === artBase) return false
    }
    return true
  })
}

export function buildAutonomousRepairBlock(
  step: SubagentTaskStep,
  feedback: readonly string[],
): string {
  const actions = buildIssueRepairActions(step, feedback)
  const languageGuidance = buildLanguageRepairGuidance(detectArtifactFamilies(step.executionContext.targetArtifacts))
  if (actions.length === 0 && languageGuidance.length === 0) return ""

  const lines = [
    "",
    "AUTONOMOUS REPAIR PLAN — treat verifier findings as ground truth and fix them without asking for human clarification:",
    ...actions.map((action, index) => `${index + 1}. ${action}`),
    ...(languageGuidance.length > 0
      ? ["", "LANGUAGE-SPECIFIC EXECUTION RULES:", ...languageGuidance.map((rule, index) => `${index + 1}. ${rule}`)]
      : []),
  ]

  return `\n\n${lines.join("\n")}`
}

export function summarizeRepairTask(task: RepairTask): { primary: string[]; reference: string[] } {
  return {
    primary: task.ownedIssues.map((issue) => issue.summary),
    reference: task.dependencyContext.map((issue) => issue.summary),
  }
}

// ============================================================================
// Tool call path normalization + artifact collection
// ============================================================================

export function normalizeToolCallPath(value: unknown): string {
  return typeof value === "string" ? value.replace(/^\.\//, "") : ""
}

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
  stepResult: PipelineStepResult,
): PipelineStepResult {
  if (stepResult.toolCalls == null && stepResult.childResult == null) return stepResult

  const findings: ContractReconciliationFinding[] = []
  const reportedArtifacts = collectReportedArtifacts(stepResult)
  const targetArtifacts = new Set(step.executionContext.targetArtifacts.map(normalizeToolCallPath))
  const sourceArtifacts = new Set(step.executionContext.requiredSourceArtifacts.map(normalizeToolCallPath))
  const forbiddenArtifacts = new Set((step.executionContext.forbiddenArtifacts ?? []).map(normalizeToolCallPath))

  const forbiddenTouched = [...reportedArtifacts].filter((artifact) => forbiddenArtifacts.has(artifact))
  if (forbiddenTouched.length > 0) {
    findings.push({
      code: "forbidden_artifact_write",
      severity: "error",
      message: `Step modified forbidden artifacts: ${forbiddenTouched.join(", ")}`,
      artifactPaths: forbiddenTouched,
    })
  }

  // Skip missing-output check when the child explicitly reported success with no blockers:
  // the target artifacts were already produced in a prior attempt and remain on disk.
  const childAlreadySatisfied = stepResult.childResult?.status === "success" &&
    (stepResult.childResult.unresolvedBlockers.length ?? 0) === 0
  const missingOutputs = step.executionContext.effectClass !== "readonly" && !childAlreadySatisfied
    ? [...targetArtifacts].filter((artifact) => !reportedArtifacts.has(artifact))
    : []
  if (missingOutputs.length > 0) {
    findings.push({
      code: "missing_required_output",
      severity: "error",
      message: `Step did not produce or modify all required target artifacts: ${missingOutputs.join(", ")}`,
      artifactPaths: missingOutputs,
    })
  }

  const hallucinatedArtifacts = [...reportedArtifacts].filter((artifact) => !targetArtifacts.has(artifact) && !sourceArtifacts.has(artifact))
  if (hallucinatedArtifacts.length > 0) {
    findings.push({
      code: "hallucinated_artifact",
      severity: "error",
      message: `Step reported mutations to artifacts outside its contract: ${hallucinatedArtifacts.join(", ")}`,
      artifactPaths: hallucinatedArtifacts,
    })
  }

  if ((stepResult.childResult?.unresolvedBlockers.length ?? 0) > 0) {
    findings.push({
      code: "unresolved_blocker",
      severity: "error",
      message: `Step reported unresolved blockers: ${stepResult.childResult!.unresolvedBlockers.join("; ")}`,
      artifactPaths: [],
    })
  }

  if ((step.executionContext.requiredChecks?.length ?? 0) > 0 && (stepResult.verificationAttempts?.length ?? 0) === 0) {
    findings.push({
      code: "required_check_skipped",
      severity: "warning",
      message: "Step completed without recording any verification attempts for its required checks.",
      artifactPaths: [],
    })
  }

  if (findings.length === 0) {
    return {
      ...stepResult,
      reconciliation: {
        compliant: true,
        findings: [],
      },
    }
  }

  const hasErrors = findings.some((finding: ContractReconciliationFinding) => finding.severity === "error")
  if (!hasErrors) {
    return {
      ...stepResult,
      reconciliation: {
        compliant: true,
        findings,
      },
    }
  }

  return {
    ...stepResult,
    status: "failed",
    executionState: "failed",
    acceptanceState: "repair_required",
    error: [stepResult.error, ...findings.filter((finding: ContractReconciliationFinding) => finding.severity === "error").map((finding: ContractReconciliationFinding) => finding.message)].filter(Boolean).join("\n"),
    reconciliation: {
      compliant: false,
      findings,
    },
  }
}

// ============================================================================
// Blueprint retry guidance
// ============================================================================

export function isBlueprintLikeStep(step: SubagentTaskStep): boolean {
  return /blueprint/i.test(step.name)
    || step.executionContext.targetArtifacts.some((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
}

export async function executeToolForText(tool: Tool, args: Record<string, unknown>): Promise<string> {
  return normalizeToolExecutionOutput(await tool.execute(args)).result
}

export function buildBlueprintRetryGuidance(
  step: SubagentTaskStep,
  plan: Plan,
  feedback: readonly string[],
): string {
  if (!isBlueprintLikeStep(step)) return ""
  const blueprintPath = step.executionContext.targetArtifacts.find((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  if (!blueprintPath) return ""
  const plannedArtifacts = getPlannedBlueprintArtifacts(plan)
  const template = buildBlueprintSeedTemplate(blueprintPath, plannedArtifacts)
  const exactTargetList = plannedArtifacts.map((artifact, index) => `${index + 1}. ${artifact}`).join("\n")

  return [
    "",
    "⚠️ BLUEPRINT CONTRACT REPAIR — FOLLOW THESE INSTRUCTIONS EXACTLY:",
    `- Rewrite only \"${blueprintPath}\".`,
    "- REQUIRED machine-readable fence name: `blueprint-contract`.",
    "- REQUIRED exact planned artifact paths:",
    exactTargetList,
    "- REQUIRED top-level machine fields: `version`, `files`, and `sharedTypes`.",
    "- REQUIRED per-file machine fields: `path`, `purpose`, and `functions` (use [] when no exported functions exist).",
    "- Remove any invented file paths or substitute module names from the prior attempt.",
    "- After writing the file, immediately call read_file on the same BLUEPRINT.md and compare the read-back content against the exact path list above.",
    "- If the read-back file is missing the `blueprint-contract` fence, any path differs, or any required field is omitted, rewrite it and read it again before finishing.",
    ...(feedback.length > 0
      ? ["- Previous failure details:", ...feedback.map((item) => `  - ${item}`)]
      : []),
    "",
    "MANDATORY TEMPLATE TO FILL:",
    template,
  ].join("\n")
}

export function hasSuccessfulReadBackAfterWrite(
  calls: readonly ToolCallRecord[],
  targetPath: string,
): boolean {
  const normalizedTarget = normalizeToolCallPath(targetPath)
  const basename = normalizedTarget.split("/").pop() ?? normalizedTarget
  let lastWriteIndex = -1

  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    if (call.isError) continue
    if (call.name !== "write_file" && call.name !== "replace_in_file") continue
    const callPath = normalizeToolCallPath(call.args.path)
    if (callPath === normalizedTarget || callPath === basename) {
      lastWriteIndex = index
    }
  }

  if (lastWriteIndex < 0) return false

  for (let index = lastWriteIndex + 1; index < calls.length; index += 1) {
    const call = calls[index]
    if (call.isError || call.name !== "read_file") continue
    const callPath = normalizeToolCallPath(call.args.path)
    if (callPath === normalizedTarget || callPath === basename) {
      return true
    }
  }

  return false
}

export async function validateBlueprintStepCompletion(
  step: SubagentTaskStep,
  calls: readonly ToolCallRecord[],
  validationCtx?: SubagentStepValidationContext,
): Promise<SubagentValidationFailure | null> {
  if (!isBlueprintLikeStep(step)) return null
  const blueprintPath = step.executionContext.targetArtifacts.find((artifact) => /(?:^|\/)BLUEPRINT\.md$/i.test(artifact))
  const readFileTool = validationCtx?.readFileTool
  if (!blueprintPath || !readFileTool) return null

  if (!hasSuccessfulReadBackAfterWrite(calls, blueprintPath)) {
    return {
      code: "acceptance_evidence_missing",
      message:
        `BLUEPRINT SELF-CHECK MISSING: Step \"${step.name}\" must read back ${blueprintPath} after writing it and repair the same file until the \`blueprint-contract\` fence and exact planned targetArtifacts are present.`,
    }
  }

  const blueprintContent = await executeToolForText(readFileTool, { path: blueprintPath })
  if (/^Error:\s*(?:ENOENT|ENOTDIR|EISDIR|EACCES|EPERM|Path|Symlink|A parent directory)/i.test(blueprintContent)) {
    return {
      code: "acceptance_evidence_missing",
      message: `BLUEPRINT CONTRACT UNREADABLE: could not read ${blueprintPath} after generation (${blueprintContent})`,
    }
  }

  if (validationCtx) {
    const blueprintIssues = validateBlueprintArtifactContract(step, validationCtx.plan, blueprintPath, blueprintContent)
    if (blueprintIssues.length > 0) {
      return {
        code: "acceptance_evidence_missing",
        message: blueprintIssues.join("; "),
      }
    }
  }

  return null
}

// Re-export for use in pipeline-steps.ts
export interface SubagentValidationFailure {
  code?: import("../../delegation-validation.js").DelegationOutputValidationCode
  message: string
}
