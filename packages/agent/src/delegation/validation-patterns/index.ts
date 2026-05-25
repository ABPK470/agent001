import { StepRole, VerificationMode } from "@mia/agent"
import { TaskIntent } from "../../domain/enums/delegation.js"
/**
 * Delegation validation patterns — evidence helpers and spec requirement
 * classifiers. Pattern constants are in
 * delegation-validation-patterns/constants.ts.
 *
 * @module
 */

import type { ToolCallRecord } from "../../tools/index.js"
import type { DelegationContractSpec } from "../validation/index.js"
import {
    DOCUMENTATION_TASK_RE,
    EXECUTABLE_VERIFICATION_CMD_RE,
    FILE_ARTIFACT_RE,
    FILE_MUTATION_TOOLS,
    FILE_READ_TOOLS,
    IMPLEMENTATION_TASK_RE,
    LOCAL_ARTIFACT_REFERENCE_RE,
    LOW_SIGNAL_BROWSER_TARGETS,
    LOW_SIGNAL_BROWSER_TOOLS,
    MEANINGFUL_BROWSER_TOOLS,
    NON_WORKSPACE_REF_RE,
    RESEARCH_TASK_RE,
    SHELL_FILE_WRITE_RE,
    SHELL_IN_PLACE_EDIT_RE,
    SHELL_SCAFFOLD_RE,
    VALIDATION_TASK_RE,
    WORKSPACE_FILE_EXT_RE,
} from "./constants.js"

// Re-export every constant so existing call-sites still work
export * from "./constants.js"

// ── Path / artifact helpers ─────────────────────────────────────

/** Normalize artifact-like paths for resilient comparisons. (Internal to delegation cluster.) */
export function normalizeArtifactPath(value: string): string {
  const cleaned = value.trim().replace(/^['"`]|['"`]$/g, "")
  return cleaned.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase()
}

/** Extract a best-effort path argument from a tool call. */
export function getToolCallPathArg(record: ToolCallRecord): string | null {
  const candidateKeys = ["path", "file", "filePath", "target", "dest", "destination"] as const
  for (const key of candidateKeys) {
    const raw = record.args[key]
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw
    }
  }
  return null
}

export function hasMutationPathEvidence(record: ToolCallRecord): boolean {
  const pathArg = getToolCallPathArg(record)
  if (pathArg && pathArg.trim().length > 0) return true
  return FILE_ARTIFACT_RE.test(record.result)
}

/** Extract local artifact references from source content. */
export function extractLocalArtifactReferences(content: string): string[] {
  const refs = new Set<string>()
  for (const match of content.matchAll(LOCAL_ARTIFACT_REFERENCE_RE)) {
    const raw = match[1]?.trim()
    if (!raw || NON_WORKSPACE_REF_RE.test(raw)) continue
    if (isLikelyNonArtifactLiteral(raw)) continue
    refs.add(raw)
  }
  return [...refs]
}

function isLikelyNonArtifactLiteral(raw: string): boolean {
  if (/^\d+(?:\.\d+)?(?:rem|em|px|vh|vw|vmin|vmax|ch|ex|fr|pt|pc|cm|mm|in|s|ms|deg|rad|turn|%)$/i.test(raw)) {
    return true
  }
  const normalized = raw.replace(/^\.{1,2}\//, "")
  const base = normalized.split("/").pop() ?? normalized
  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return false
  const ext = base.slice(dot + 1)
  return !WORKSPACE_FILE_EXT_RE.test(ext)
}

// ── Task intent classification ──────────────────────────────────

export type { TaskIntent }

/** Classify the intent of a delegated task from its spec. */
export function classifyTaskIntent(spec: DelegationContractSpec): TaskIntent {
  const text = `${spec.task} ${spec.acceptanceCriteria.join(" ")}`

  let implScore = 0
  let researchScore = 0
  let validationScore = 0
  let docScore = 0

  if (IMPLEMENTATION_TASK_RE.test(text)) implScore += 2
  if (RESEARCH_TASK_RE.test(text)) researchScore += 2
  if (VALIDATION_TASK_RE.test(text)) validationScore += 2
  if (DOCUMENTATION_TASK_RE.test(text)) docScore += 2

  if (spec.effectClass !== "readonly") implScore += 1
  if (spec.targetArtifacts.length > 0) implScore += 2
  if (spec.role === StepRole.Writer) implScore += 1
  if (spec.role === StepRole.Reviewer) researchScore += 1
  if (spec.role === StepRole.Validator) validationScore += 1

  const maxScore = Math.max(implScore, researchScore, validationScore, docScore)
  if (maxScore === 0) return TaskIntent.Mixed

  const scores = [
    { intent: TaskIntent.Implementation, score: implScore },
    { intent: TaskIntent.Research, score: researchScore },
    { intent: TaskIntent.Validation, score: validationScore },
    { intent: TaskIntent.Documentation, score: docScore },
  ]

  scores.sort((a, b) => b.score - a.score)
  if (scores.length >= 2 && scores[0].score - scores[1].score <= 1 && scores[1].score > 0) {
    return TaskIntent.Mixed
  }

  return scores[0].intent
}

// ── Evidence extraction helpers ─────────────────────────────────

/** Extract distinctive tokens from acceptance criteria for evidence matching. */
export function extractAcceptanceTokens(criteria: readonly string[]): string[] {
  const tokens = new Set<string>()
  for (const criterion of criteria) {
    const words = criterion.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
    for (const word of words) tokens.add(word)
  }
  return [...tokens]
}

/** Check if a tool call represents a file mutation. */
export function isFileMutationToolCall(record: ToolCallRecord): boolean {
  if (FILE_MUTATION_TOOLS.has(record.name)) return true
  if (record.name === "run_command") {
    const cmd = typeof record.args.command === "string" ? record.args.command : ""
    if (SHELL_FILE_WRITE_RE.test(cmd)) return true
    if (SHELL_IN_PLACE_EDIT_RE.test(cmd)) return true
    if (SHELL_SCAFFOLD_RE.test(cmd)) return true
  }
  return false
}

/** Check if a tool call represents a workspace read/inspection. */
export function isWorkspaceInspectionToolCall(record: ToolCallRecord): boolean {
  return FILE_READ_TOOLS.has(record.name)
}

/** Check if a tool call is a low-signal browser action. */
export function isLowSignalBrowserToolCall(record: ToolCallRecord): boolean {
  if (LOW_SIGNAL_BROWSER_TOOLS.has(record.name)) return true
  if (MEANINGFUL_BROWSER_TOOLS.has(record.name)) {
    const url = typeof record.args.url === "string" ? record.args.url : ""
    const path = typeof record.args.path === "string" ? record.args.path : ""
    if (LOW_SIGNAL_BROWSER_TARGETS.has(url) && !path) return true
  }
  return false
}

/** Check if a tool call is a meaningful browser action. */
export function isMeaningfulBrowserToolCall(record: ToolCallRecord): boolean {
  if (!MEANINGFUL_BROWSER_TOOLS.has(record.name)) return false
  return !isLowSignalBrowserToolCall(record)
}

/** Check if a tool call provides executable verification evidence. */
export function isExecutableVerificationToolCall(record: ToolCallRecord): boolean {
  if (isMeaningfulBrowserToolCall(record)) return true
  if (record.name === "run_command" && typeof record.args.command === "string") {
    return EXECUTABLE_VERIFICATION_CMD_RE.test(record.args.command)
  }
  return false
}

/** Check if at least one target artifact was inspected after mutation. */
export function hasPostMutationArtifactInspection(
  toolCalls: readonly ToolCallRecord[],
  targetArtifacts: readonly string[],
): boolean {
  const targetBasenames = new Set(targetArtifacts.map(a => a.split("/").pop() ?? a))
  let sawMutation = false
  for (const tc of toolCalls) {
    if (!tc.isError && isFileMutationToolCall(tc)) {
      sawMutation = true
      continue
    }
    if (!sawMutation || tc.isError) continue
    if (!FILE_READ_TOOLS.has(tc.name)) continue
    const path = typeof tc.args.path === "string" ? tc.args.path : ""
    if (!path) continue
    const basename = path.split("/").pop() ?? path
    if (targetBasenames.has(basename) || targetArtifacts.some(t => t === path || path.endsWith(`/${t.split("/").pop() ?? t}`))) {
      return true
    }
  }
  return false
}

// ── Spec requirements classification ────────────────────────────

/** Determine if the contract requires file mutation evidence. */
export function specRequiresFileMutationEvidence(spec: DelegationContractSpec): boolean {
  if (spec.effectClass === "readonly") return false
  if (spec.role === StepRole.Writer && spec.targetArtifacts.length > 0) return true
  const intent = classifyTaskIntent(spec)
  if (intent === TaskIntent.Implementation && spec.targetArtifacts.length > 0) return true
  if (intent === "mixed" && spec.targetArtifacts.length > 0) return true
  return false
}

/** Determine if the contract requires successful tool evidence. */
export function specRequiresSuccessfulToolEvidence(spec: DelegationContractSpec): boolean {
  if (spec.tools.length === 0) return false
  return spec.targetArtifacts.length > 0 || spec.acceptanceCriteria.length > 0
}

/** Determine if the contract requires workspace inspection evidence. */
export function specRequiresWorkspaceInspection(spec: DelegationContractSpec): boolean {
  if (spec.requiredSourceArtifacts.length > 0) return true
  if (spec.role === StepRole.Reviewer || spec.role === StepRole.Grounding) return true
  return false
}

/** Determine if the contract requires meaningful browser evidence. */
export function specRequiresBrowserEvidence(spec: DelegationContractSpec): boolean {
  return spec.verificationMode === VerificationMode.BrowserCheck
}
