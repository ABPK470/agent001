/**
 * Pipeline repair helpers — build feedback, repair actions, and retry guidance
 * for subagent steps during pipeline execution.
 *
 * Extracted from pipeline.ts for maintainability.
 *
 * @module
 */

import type { ToolCallRecord } from "../recovery.js"
import { normalizeToolExecutionOutput } from "../tool-utils.js"
import type { Tool } from "../types.js"
import {
    buildBlueprintSeedTemplate,
    getPlannedBlueprintArtifacts,
    validateBlueprintArtifactContract,
} from "./blueprint-contract.js"
import type {
    ContractReconciliationFinding,
    PipelineStepResult,
    Plan,
    PlannerRuntimeModel,
    RepairPlan,
    RepairTask,
    SubagentTaskStep,
} from "./types.js"

// ============================================================================
// Internal types
// ============================================================================

export interface SubagentStepValidationContext {
  plan: Plan
  readFileTool?: Tool
  workspaceRoot?: string
  knownProjectArtifacts?: readonly string[]
}

type ArtifactFamily =
  | "javascript"
  | "typescript"
  | "python"
  | "sql"
  | "html"
  | "posix-shell"
  | "powershell"
  | "windows-cmd"

// ============================================================================
// Artifact family detection + language guidance
// ============================================================================

export function detectArtifactFamilies(artifacts: readonly string[]): Set<ArtifactFamily> {
  const families = new Set<ArtifactFamily>()
  for (const artifact of artifacts) {
    const lower = artifact.toLowerCase()
    if (/(?:\.jsx?|\.mjs|\.cjs)$/.test(lower)) families.add("javascript")
    if (/(?:\.tsx?|\.mts|\.cts)$/.test(lower)) families.add("typescript")
    if (/\.py$/.test(lower)) families.add("python")
    if (/\.sql$/.test(lower)) families.add("sql")
    if (/\.html?$/.test(lower)) families.add("html")
    if (/\.(?:sh|bash|zsh|fish)$/.test(lower) || /(?:^|\/)makefile$/i.test(artifact)) families.add("posix-shell")
    if (/\.(?:ps1|psm1|psd1)$/.test(lower)) families.add("powershell")
    if (/\.(?:cmd|bat)$/.test(lower)) families.add("windows-cmd")
  }
  return families
}

export function buildLanguageRepairGuidance(families: ReadonlySet<ArtifactFamily>): string[] {
  const guidance: string[] = []
  if (families.has("javascript") || families.has("typescript")) {
    guidance.push("JS/TS: preserve module exports, import paths, and public function signatures; make surgical edits instead of rewriting working files")
  }
  if (families.has("python")) {
    guidance.push("Python: preserve function names and call contracts exactly; fix indentation, imports, and control flow without changing the declared API")
  }
  if (families.has("sql")) {
    guidance.push("SQL: preserve schema/table/column names from the spec exactly; repair query logic and DDL/DML semantics without inventing new schema")
  }
  if (families.has("html")) {
    guidance.push("HTML/UI: preserve declared ids, classes, data attributes, and referenced asset paths exactly as the spec defines them")
  }
  if (families.has("posix-shell")) {
    guidance.push("POSIX shell: keep commands portable for sh/bash/zsh where possible, quote paths safely, and avoid non-portable syntax unless the target shell explicitly requires it")
  }
  if (families.has("powershell")) {
    guidance.push("PowerShell: preserve cmdlet/function names and parameter contracts, use native PowerShell syntax instead of POSIX shell idioms, and keep Windows path handling explicit")
  }
  if (families.has("windows-cmd")) {
    guidance.push("Windows CMD: use cmd.exe syntax, preserve batch labels and variable expansion rules, and avoid injecting Bash or PowerShell syntax into .cmd/.bat files")
  }
  return guidance
}

// ============================================================================
// Issue repair actions
// ============================================================================

export function buildIssueRepairActions(step: SubagentTaskStep, feedback: readonly string[]): string[] {
  const actions: string[] = []

  for (const issue of feedback) {
    const cleanIssue = issue.replace(/^\[non-blocking\]\s*/i, "")

    if (/SPEC FUNCTION MISMATCH:/i.test(cleanIssue)) {
      const match = cleanIssue.match(/SPEC FUNCTION MISMATCH:\s+(.+?)\s+is missing blueprint functions\s+(.+?)\s+from\s+(.+)$/i)
      if (match) {
        const artifactPath = match[1].trim()
        if (/\.(?:html?|css|scss|sass|less|md|markdown|txt|rst|adoc)$/i.test(artifactPath)) {
          actions.push(
            `Do NOT implement runtime functions in ${artifactPath}; reconcile the contract and wiring so ${artifactPath} only carries structure/presentation responsibilities and the missing functions are owned by executable source artifacts.`,
          )
        } else {
          actions.push(`Read ${match[3]} and ${artifactPath}, then implement exactly these missing functions in ${artifactPath}: ${match[2]}`)
        }
      } else {
        actions.push("Read the blueprint and target artifact, then implement every missing function signature exactly as declared")
      }
      continue
    }

    if (/SPEC STRUCTURE MISMATCH:/i.test(cleanIssue)) {
      const match = cleanIssue.match(/SPEC STRUCTURE MISMATCH:\s+(.+?)\s+is missing blueprint structure markers\s+(.+?)\s+from\s+(.+)$/i)
      if (match) {
        actions.push(`Update ${match[1]} so it contains these required structural elements from ${match[3]}: ${match[2]}`)
      } else {
        actions.push("Align the produced artifact with the structural elements declared in the blueprint before changing unrelated code")
      }
      continue
    }

    if (/SPEC MAPPING MISSING:/i.test(cleanIssue)) {
      actions.push("Map each target artifact to a concrete blueprint file/section before editing; do not invent files or responsibilities not declared in the spec")
      continue
    }

    if (/SPEC PATH MISMATCH:/i.test(cleanIssue) || /PATH MISMATCH:/i.test(cleanIssue)) {
      actions.push("Write to the exact target path from the plan; do not place the fix in an alternate directory or sibling file")
      continue
    }

    if (/PROCESS AUDIT FAILED:.*never read/i.test(cleanIssue)) {
      actions.push("First read BLUEPRINT.md before making any change, then read each target artifact you will modify, and only then start mutations")
      continue
    }

    if (/PROCESS AUDIT FAILED:.*after starting file mutations/i.test(cleanIssue)) {
      actions.push("Reorder the workflow: read spec first, read current target files second, mutate files only after both reads are complete")
      continue
    }

    if (/PROCESS AUDIT WEAK:/i.test(cleanIssue)) {
      actions.push("Read the existing target files before editing so the next attempt patches current code instead of regenerating blindly")
      continue
    }

    if (/Placeholder\/stub code|stub|placeholder|degeneration|empty function|trivial return|returns constant/i.test(cleanIssue)) {
      actions.push("Replace every stub or placeholder body with real executable logic; keep the signature but rewrite the body completely")
      continue
    }

    if (/Syntax error/i.test(cleanIssue)) {
      actions.push("Fix syntax and parse errors first so the artifact can be executed or checked before addressing secondary issues")
      continue
    }

    if (/Browser check/i.test(cleanIssue)) {
      actions.push("Repair the runtime failure reported by browser verification, then re-check the referenced UI wiring and asset loading paths")
      continue
    }

    if (/shared-state contract/i.test(cleanIssue)) {
      actions.push("Consume the declared shared-state owner artifact exactly as required; do not duplicate or fork shared state logic")
      continue
    }

    if (/SCOPE VIOLATION/i.test(cleanIssue)) {
      const forbiddenMatch = cleanIssue.match(/path\s+["']([^"']+)["']\s+is outside/i)
      const allowedMatch = cleanIssue.match(/Allowed targetArtifacts[^:]*:\s*([^.]+)/i)
      const ownedFiles = step.executionContext.targetArtifacts
      if (forbiddenMatch && allowedMatch) {
        const forbidden = forbiddenMatch[1]
        const allowed = allowedMatch[1].trim()
        actions.push(
          `SCOPE CONSTRAINT VIOLATION: you tried to write "${forbidden}" which is NOT one of your target files. ` +
          `YOUR ONLY ALLOWED TARGET FILES ARE: ${allowed}. ` +
          `Do NOT write "${forbidden}" under any circumstances — it is owned by a different pipeline step. ` +
          `Focus exclusively on writing: ${ownedFiles.join(", ")}.`,
        )
      } else if (ownedFiles.length > 0) {
        actions.push(
          `SCOPE CONSTRAINT: your ONLY allowed target files are: ${ownedFiles.join(", ")}. ` +
          `Do not write or modify any other file. If the task feels incomplete without writing additional files, ` +
          `ignore that feeling — the other files are the responsibility of a different pipeline step.`,
        )
      } else {
        actions.push("Edit only this step's owned target artifacts unless a required source artifact explicitly allows integration wiring changes")
      }
      continue
    }

    if (/VERIFICATION MODALITY GAP/i.test(cleanIssue)) {
      actions.push("Produce artifacts that are straightforward to verify deterministically: valid syntax, explicit entrypoints, and concrete file outputs")
      continue
    }
  }

  return [...new Set(actions)]
}

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

  const missingOutputs = step.executionContext.effectClass !== "readonly"
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
  code?: import("../delegation-validation.js").DelegationOutputValidationCode
  message: string
}
