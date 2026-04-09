/**
 * Delegation output contract validation — structured evidence-based checks.
 *
 * Ported from agenc-core's delegation-validation.ts.
 * This module provides deterministic, code-level validation of child agent
 * outputs BEFORE the LLM verifier runs. Instead of trusting the child's
 * self-reported summary, it cross-references:
 *   - Tool calls actually made (names, args, results)
 *   - File paths mentioned vs. files actually written
 *   - Acceptance criteria tokens vs. output text
 *   - Completion claims vs. unresolved work markers
 *
 * The 12 validation codes map to specific, actionable failure modes that
 * drive correction routing on retry.
 *
 * @module
 */

// ============================================================================
// Validation codes — the contract enforcement taxonomy
// ============================================================================

/**
 * Each code maps to a specific failure mode with distinct remediation.
 * On retry, the lastValidationCode is fed back to the child so it knows
 * exactly what class of fix is needed.
 */
export const DELEGATION_OUTPUT_VALIDATION_CODES = [
  /** Output is empty string after trimming. */
  "empty_output",
  /** Output is literally null, undefined, {}, or []. */
  "empty_structured_payload",
  /** Acceptance criteria tokens not evidenced in child output at all. */
  "acceptance_evidence_missing",
  /** Child claims "done"/"completed" but text contains unresolved work markers. */
  "contradictory_completion_claim",
  /** Contract implies file mutation but child used no file-writing tools. */
  "missing_file_mutation_evidence",
  /** Child made zero successful tool calls despite needing tools. */
  "missing_successful_tool_evidence",
  /** Child output says work is "blocked" or "incomplete" instead of completing it. */
  "blocked_phase_output",
  /** File mutation tools were used but output doesn't identify any file paths. */
  "missing_file_artifact_evidence",
  /** Child claims to have read/modified files but has no read_file evidence. */
  "missing_workspace_inspection_evidence",
  /** Child was supposed to read source files first but didn't. */
  "missing_required_source_evidence",
  /** All tool calls reported failure — zero successful executions. */
  "all_tools_failed",
  /** Browser evidence is low-signal (only about:blank or tab listing). */
  "low_signal_browser_evidence",
  /** Implementation output lacks executable verification evidence. */
  "missing_executable_verification_evidence",
  /** Child asks for continuation or describes output as partial/foundation. */
  "unresolved_handoff_output",
  /** Contract declares target artifacts but child touched none of them. */
  "missing_target_artifact_coverage",
  /** Written content references local artifacts with no existence evidence. */
  "unresolved_artifact_references",
] as const

export type DelegationOutputValidationCode =
  typeof DELEGATION_OUTPUT_VALIDATION_CODES[number]

// ============================================================================
// Core interfaces
// ============================================================================

/**
 * A single tool call made by the child agent.
 * Re-exports the existing ToolCallRecord from recovery.ts for compatibility,
 * extended with a `success` convenience accessor.
 *
 * The existing ToolCallRecord uses `isError: boolean` — we normalize this
 * in the validation functions via `!record.isError`.
 */
export type { ToolCallRecord } from "./recovery.js"
import type { ToolCallRecord } from "./recovery.js"

/**
 * The contract spec for a delegation — what we expected the child to do.
 * Built from the SubagentTaskStep + ExecutionEnvelope.
 */
export interface DelegationContractSpec {
  /** The task/objective given to the child. */
  readonly task: string
  /** Measurable acceptance criteria. */
  readonly acceptanceCriteria: readonly string[]
  /** Files/dirs the child was expected to create/modify. */
  readonly targetArtifacts: readonly string[]
  /** Source files the child was supposed to read first. */
  readonly requiredSourceArtifacts: readonly string[]
  /** Tools the child was given access to. */
  readonly tools: readonly string[]
  /** What filesystem effects this child should produce. */
  readonly effectClass: "readonly" | "filesystem_write" | "filesystem_scaffold" | "shell" | "mixed"
  /** How the parent will verify (e.g., browser_check, run_tests). */
  readonly verificationMode: string
  /** Step role: writer, reviewer, validator, grounding. */
  readonly role: "writer" | "reviewer" | "validator" | "grounding"
  /** Last validation code from a prior attempt (for correction routing). */
  readonly lastValidationCode?: DelegationOutputValidationCode
  /**
   * Optional full artifact set planned across the workflow.
   * Used to avoid false unresolved-reference failures while artifacts are
   * still being assembled across sibling steps.
   */
  readonly knownProjectArtifacts?: readonly string[]
}

/**
 * Result of contract validation — deterministic, no LLM needed.
 */
export interface DelegationOutputValidationResult {
  /** Whether the output passes contract validation. */
  readonly ok: boolean
  /** Specific failure code (undefined when ok=true). */
  readonly code?: DelegationOutputValidationCode
  /** Human-readable description of the failure. */
  readonly message?: string
}

// ============================================================================
// Regex patterns — evidence detection (agenc-core pattern)
// ============================================================================

/** Empty values that indicate no real output. */
const EMPTY_VALUES = new Set(["null", "undefined", "{}", "[]", ""])

/** Completion claim language in output text. */
const COMPLETION_CLAIM_RE =
  /\b(?:done|complete(?:d)?|finished|implemented|created|written|ready|passes?|passing|succeeds?|successful(?:ly)?|meets?(?: the)? acceptance criteria|all (?:tasks?|criteria|requirements?) (?:met|satisfied|done))\b/i

/** Unresolved work markers — the child claims "done" but these indicate otherwise. */
const UNRESOLVED_WORK_RE =
  /\b(?:TODO|FIXME|HACK|XXX|NOT YET|UNFINISHED|NEEDS? (?:TO BE )?IMPLEMENT|WILL GO HERE|WILL BE ADDED|WAITING FOR|DEPENDS ON|UNABLE TO|FAILED TO|ERROR(?:S)? (?:OCCURRED|ENCOUNTERED)|REMAINING WORK|FOLLOW[- ]?UP|PARTIAL(?:LY)? IMPLEMENTED)\b/i

/**
 * Context-sensitive markers — only flag these when they appear in "unresolved work"
 * context, not in normal English descriptions like "for later clearing" or
 * "checking for incomplete implementations".
 */
const CONTEXT_SENSITIVE_MARKERS: Array<{ re: RegExp; label: string }> = [
  // "later" only when preceded by action verbs: "do later", "implement later", "fix later"
  { re: /\b(?:do|implement|fix|add|handle|address|revisit|come back(?:to)?)\s+later\b/i, label: "later" },
  // "incomplete" only when describing the work itself: "implementation is incomplete", "incomplete code"
  { re: /\b(?:incomplete\s+(?:implementation|code|logic|work|feature)|(?:implementation|code|logic|work|feature)\s+(?:is|are|remains?)\s+incomplete)\b/i, label: "incomplete" },
  // "will be" only in deferred-work patterns: "will be implemented", "will be done"
  { re: /\bwill be\s+(?:implemented|added|done|completed|fixed|handled|addressed)\b/i, label: "will be" },
  // "blocked on" only when describing a blocker for the task
  { re: /\b(?:blocked on|blocked by)\s+(?:a |the |an )?(?:missing|lack|absence|dependency|requirement|issue|bug|error)/i, label: "blocked on" },
  // "can't" / "cannot" only when admitting inability to complete work
  { re: /\b(?:can'?t|cannot)\s+(?:implement|complete|finish|fix|resolve|access|proceed)/i, label: "can't" },
  // placeholder/stub only when explicitly describing unfinished implementation
  { re: /\b(?:placeholder|stub)\s+(?:logic|code|function|implementation)\b/i, label: "placeholder/stub" },
]

/** File mutation tool names — tools that create/modify/delete files. */
const FILE_MUTATION_TOOLS = new Set([
  "write_file", "create_file", "append_file", "delete_file",
  "edit_file", "patch_file",
])

/** File reading tool names. */
const FILE_READ_TOOLS = new Set([
  "read_file", "list_directory", "search_files",
])

/** Commands that provide executable verification evidence. */
const EXECUTABLE_VERIFICATION_CMD_RE =
  /\b(?:npm\s+test|npm\s+run\s+(?:test|lint|build|check)|pnpm\s+(?:test|lint|build|check)|yarn\s+(?:test|lint|build|check)|vitest|jest|pytest|go\s+test|cargo\s+test|cargo\s+check|mvn\s+test|gradle\s+test|ruff\s+check|eslint|tsc\b|phpunit|dotnet\s+test)\b/i

/** Browser runtime/load failures that invalidate browser_check evidence. */
const BROWSER_RUNTIME_FAILURE_RE =
  /(Failed to load resource|net::ERR_|status of 404|\b404\b|ReferenceError|TypeError|SyntaxError|Total:\s*[1-9]\d*\s+error\(s\))/i

/** Shell commands that create/modify files. */
const SHELL_FILE_WRITE_RE =
  /\b(?:tee|touch|cp|mv|install)\b|\bcat\b[^\n]*\s(?:>|>>|<<)\s*\S|(?:^|[^>])>{1,2}\s*\S/i

/** Shell in-place edit commands. */
const SHELL_IN_PLACE_EDIT_RE =
  /\b(?:sed|perl|ruby)\b(?:(?![|;&\n]).)*\s-(?:[A-Za-z]*i|pi)(?:\b|=|['"])/i

/** Shell scaffold commands (npm create, cargo new, etc.). */
const SHELL_SCAFFOLD_RE =
  /\b(?:npm\s+(?:create|init)|pnpm\s+(?:create|init)|yarn\s+create|bun\s+create|cargo\s+(?:new|init)|git\s+clone)\b/i

/** File path evidence in output text. */
const FILE_ARTIFACT_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]+|\.{1,2}\/[^\s`'"]+|[a-z0-9_-]+(?:\/[a-z0-9_.-]+)+|[a-z0-9_.-]+\.[a-z0-9]{1,10})(?=$|[\s`'"])/i

/** Basic local file reference patterns found inside source content. */
const LOCAL_ARTIFACT_REFERENCE_RE =
  /["'`](\.{1,2}\/[^"'`\s]+|[a-z0-9_.-]+\/[a-z0-9_./-]+|[a-z0-9_.-]+\.[a-z0-9]{1,10})["'`]/gi

/** Extensions likely to represent workspace artifacts (not numeric/style literals). */
const WORKSPACE_FILE_EXT_RE =
  /^(?:html?|css|js|mjs|cjs|jsx|ts|tsx|json|ya?ml|xml|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|map|md|txt|sql|sh|bash|zsh|py|rb|java|cs|go|rs|php)$/i

/** Ignore URL-like and anchor references that are not workspace artifacts. */
const NON_WORKSPACE_REF_RE = /^(?:https?:|data:|mailto:|tel:|#)/i

/** Blocked/incomplete phase language. */
const BLOCKED_PHASE_RE =
  /\b(?:blocked|stuck|cannot proceed|unable to continue|waiting for|depends on|prerequisite|not possible|impossible to|can't access|no access)\b/i

/** Output text that indicates the child is handing off unfinished implementation. */
const UNRESOLVED_HANDOFF_RE =
  /\b(?:would you like to (?:proceed|continue)|should i (?:proceed|continue)|let me know if you (?:want|would like) me to (?:continue|proceed|implement)|partial(?:ly)? logic|partial(?:ly)? implementation|foundational partial implementation|this (?:project|implementation) is (?:a )?foundation|further refinements can be made|missing game mechanics)\b/i

/** Narrative file claims without tool evidence. */
const NARRATIVE_FILE_CLAIM_RE =
  /\b(?:created|wrote|saved|updated|implemented|scaffolded|generated)\b/i

/** Low-signal browser targets that don't count as meaningful evidence. */
const LOW_SIGNAL_BROWSER_TARGETS = new Set(["about:blank"])

/** Browser tools that are meaningful (navigate, snapshot, run_code). */
const MEANINGFUL_BROWSER_TOOLS = new Set([
  "browser_check", "browser_navigate", "browser_snapshot",
  "browser_run_code",
])

/** Browser tools that are low-signal (tab list, console only). */
const LOW_SIGNAL_BROWSER_TOOLS = new Set([
  "browser_tab_list", "browser_console_messages",
])

/**
 * Normalize artifact-like paths for resilient comparisons.
 */
function normalizeArtifactPath(value: string): string {
  const cleaned = value.trim().replace(/^['"`]|['"`]$/g, "")
  return cleaned.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase()
}

/**
 * Extract a best-effort path argument from a tool call.
 */
function getToolCallPathArg(record: ToolCallRecord): string | null {
  const candidateKeys = ["path", "file", "filePath", "target", "dest", "destination"] as const
  for (const key of candidateKeys) {
    const raw = record.args[key]
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw
    }
  }
  return null
}

function hasMutationPathEvidence(record: ToolCallRecord): boolean {
  const pathArg = getToolCallPathArg(record)
  if (pathArg && pathArg.trim().length > 0) return true
  return FILE_ARTIFACT_RE.test(record.result)
}

/**
 * Extract local artifact references from source content.
 */
function extractLocalArtifactReferences(content: string): string[] {
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
  // Numeric + unit literals often appear in style values (e.g. "1.8rem").
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

// ============================================================================
// Task intent classification (agenc-core pattern)
// ============================================================================

/** Regex patterns for classifying task intent. */
const RESEARCH_TASK_RE =
  /\b(?:research|find|search|look up|investigate|analyze|compare|explore|review|check|inspect|audit|summarize)\b/i

const IMPLEMENTATION_TASK_RE =
  /\b(?:implement|build|create|scaffold|write|code|develop|add|make|construct|generate|produce|render|design)\b/i

const VALIDATION_TASK_RE =
  /\b(?:test|validate|verify|check|confirm|ensure|assert|playtest|qa|e2e)\b/i

const DOCUMENTATION_TASK_RE =
  /\b(?:document|readme|docs?|guide|instructions?|how[\s-]?to|architecture|design)\b/i

export type TaskIntent = "research" | "implementation" | "validation" | "documentation" | "mixed"

/**
 * Classify the intent of a delegated task from its spec.
 * This drives downstream decisions about what evidence is required.
 */
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

  // File mutation tools → implementation
  if (spec.effectClass !== "readonly") implScore += 1
  // Target artifacts → implementation
  if (spec.targetArtifacts.length > 0) implScore += 2
  // Writer role → implementation
  if (spec.role === "writer") implScore += 1
  // Reviewer role → research
  if (spec.role === "reviewer") researchScore += 1
  // Validator role → validation
  if (spec.role === "validator") validationScore += 1

  const maxScore = Math.max(implScore, researchScore, validationScore, docScore)
  if (maxScore === 0) return "mixed"

  const scores = [
    { intent: "implementation" as const, score: implScore },
    { intent: "research" as const, score: researchScore },
    { intent: "validation" as const, score: validationScore },
    { intent: "documentation" as const, score: docScore },
  ]

  // If top two scores are close, it's mixed
  scores.sort((a, b) => b.score - a.score)
  if (scores.length >= 2 && scores[0].score - scores[1].score <= 1 && scores[1].score > 0) {
    return "mixed"
  }

  return scores[0].intent
}

// ============================================================================
// Evidence extraction helpers
// ============================================================================

/**
 * Extract distinctive tokens from acceptance criteria for evidence matching.
 * Minimum 4-char tokens, deduplicated, lowercased.
 */
export function extractAcceptanceTokens(criteria: readonly string[]): string[] {
  const tokens = new Set<string>()
  for (const criterion of criteria) {
    const words = criterion.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []
    for (const word of words) {
      tokens.add(word)
    }
  }
  return [...tokens]
}

/**
 * Check if a tool call represents a file mutation.
 */
export function isFileMutationToolCall(record: ToolCallRecord): boolean {
  // Direct file mutation tools
  if (FILE_MUTATION_TOOLS.has(record.name)) return true

  // Shell commands that write files
  if (record.name === "run_command" || record.name === "shell") {
    const cmd = typeof record.args.command === "string" ? record.args.command : ""
    if (SHELL_FILE_WRITE_RE.test(cmd)) return true
    if (SHELL_IN_PLACE_EDIT_RE.test(cmd)) return true
    if (SHELL_SCAFFOLD_RE.test(cmd)) return true
  }

  return false
}

/**
 * Check if a tool call represents a workspace read/inspection.
 */
export function isWorkspaceInspectionToolCall(record: ToolCallRecord): boolean {
  return FILE_READ_TOOLS.has(record.name)
}

/**
 * Check if a tool call is a low-signal browser action.
 */
export function isLowSignalBrowserToolCall(record: ToolCallRecord): boolean {
  if (LOW_SIGNAL_BROWSER_TOOLS.has(record.name)) return true
  // Browser tools navigating to about:blank
  if (MEANINGFUL_BROWSER_TOOLS.has(record.name)) {
    const url = typeof record.args.url === "string" ? record.args.url : ""
    const path = typeof record.args.path === "string" ? record.args.path : ""
    if (LOW_SIGNAL_BROWSER_TARGETS.has(url) && !path) return true
  }
  return false
}

/**
 * Check if a tool call is a meaningful browser action.
 */
export function isMeaningfulBrowserToolCall(record: ToolCallRecord): boolean {
  if (!MEANINGFUL_BROWSER_TOOLS.has(record.name)) return false
  return !isLowSignalBrowserToolCall(record)
}

/**
 * Check if a tool call provides executable verification evidence.
 */
export function isExecutableVerificationToolCall(record: ToolCallRecord): boolean {
  if (isMeaningfulBrowserToolCall(record)) return true
  if ((record.name === "run_command" || record.name === "shell") && typeof record.args.command === "string") {
    return EXECUTABLE_VERIFICATION_CMD_RE.test(record.args.command)
  }
  return false
}

/**
 * Check if at least one target artifact was inspected after mutation.
 */
function hasPostMutationArtifactInspection(
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

// ============================================================================
// Spec requirements classification
// ============================================================================

/**
 * Determine if the contract requires file mutation evidence.
 * Based on task intent, effect class, and target artifacts.
 */
export function specRequiresFileMutationEvidence(spec: DelegationContractSpec): boolean {
  // Readonly contracts never need mutation
  if (spec.effectClass === "readonly") return false

  // Writer role with target artifacts always needs mutation
  if (spec.role === "writer" && spec.targetArtifacts.length > 0) return true

  // Implementation tasks with target artifacts need mutation
  const intent = classifyTaskIntent(spec)
  if (intent === "implementation" && spec.targetArtifacts.length > 0) return true

  // Mixed tasks with target artifacts usually need mutation
  if (intent === "mixed" && spec.targetArtifacts.length > 0) return true

  return false
}

/**
 * Determine if the contract requires successful tool evidence.
 * Almost all tasks need at least one successful tool call.
 */
export function specRequiresSuccessfulToolEvidence(spec: DelegationContractSpec): boolean {
  // If the child has no tools, it can't use them
  if (spec.tools.length === 0) return false

  // All non-trivial tasks need tool evidence
  return spec.targetArtifacts.length > 0 || spec.acceptanceCriteria.length > 0
}

/**
 * Determine if the contract requires workspace inspection evidence.
 * Required when source files are listed or when reviewer/grounding role.
 */
export function specRequiresWorkspaceInspection(spec: DelegationContractSpec): boolean {
  if (spec.requiredSourceArtifacts.length > 0) return true
  if (spec.role === "reviewer" || spec.role === "grounding") return true
  return false
}

/**
 * Determine if the contract requires meaningful browser evidence.
 * Required for browser_check verification mode.
 */
export function specRequiresBrowserEvidence(spec: DelegationContractSpec): boolean {
  return spec.verificationMode === "browser_check"
}

// ============================================================================
// Master validation function
// ============================================================================

/**
 * Validate a delegated output against its contract.
 *
 * Runs checks in priority order and returns the first failure.
 * This is the agenc-core pattern: deterministic, evidence-based validation
 * that catches structural issues before the LLM verifier runs.
 *
 * Check order (priority):
 *   1. Empty output
 *   2. Blocked/incomplete phase
 *   3. Unresolved handoff/partial output
 *   4. Successful tool evidence
 *   5. File mutation evidence
 *   6. Workspace inspection evidence
 *   7. Required source artifact evidence
 *   8. File artifact evidence in output
 *   9. Browser evidence quality
 *  10. Contradictory completion claim
 *  11. Acceptance evidence
 */
export function validateDelegatedOutputContract(params: {
  spec: DelegationContractSpec
  output: string
  toolCalls?: readonly ToolCallRecord[]
}): DelegationOutputValidationResult {
  const { spec, output, toolCalls = [] } = params
  const trimmed = output.trim()
  const outputLower = trimmed.toLowerCase()

  // ── 1. Empty output ──
  if (trimmed.length === 0) {
    return { ok: false, code: "empty_output", message: "Child agent produced no output" }
  }
  if (EMPTY_VALUES.has(trimmed)) {
    return { ok: false, code: "empty_structured_payload", message: `Child output is empty value: ${trimmed}` }
  }

  // ── 2. Blocked phase output ──
  if (BLOCKED_PHASE_RE.test(outputLower) && !COMPLETION_CLAIM_RE.test(outputLower)) {
    // Only flag if the output predominantly signals blockage, not just mentions it
    const blockMatchCount = [...outputLower.matchAll(new RegExp(BLOCKED_PHASE_RE.source, "gi"))].length
    const lines = trimmed.split("\n").length
    if (blockMatchCount >= 2 && lines < 10) {
      const firstMatch = outputLower.match(BLOCKED_PHASE_RE)
      return {
        ok: false,
        code: "blocked_phase_output",
        message: `Child agent reported blocked/incomplete state: "${firstMatch?.[0]}"`,
      }
    }
  }

  // ── 3. Unresolved handoff / partial output ──
  // Implementation tasks must finish autonomously. If the child asks whether to
  // continue or labels output as partial/foundation, treat it as incomplete.
  const intent = classifyTaskIntent(spec)
  const isImplementationLike = intent === "implementation" || intent === "mixed"
  if (isImplementationLike && specRequiresFileMutationEvidence(spec) && UNRESOLVED_HANDOFF_RE.test(trimmed)) {
    const handoffMatch = trimmed.match(UNRESOLVED_HANDOFF_RE)
    return {
      ok: false,
      code: "unresolved_handoff_output",
      message: `Output contains unresolved handoff/partial language: "${handoffMatch?.[0]}"`,
    }
  }

  // ── 4. Successful tool evidence ──
  if (specRequiresSuccessfulToolEvidence(spec) && toolCalls.length > 0) {
    const successfulCalls = toolCalls.filter(tc => !tc.isError)
    if (successfulCalls.length === 0) {
      return {
        ok: false,
        code: "all_tools_failed",
        message: `All ${toolCalls.length} tool calls failed — zero successful executions`,
      }
    }
  }

  if (specRequiresSuccessfulToolEvidence(spec) && toolCalls.length === 0) {
    // No tool calls at all — check output for narrative claims
    if (NARRATIVE_FILE_CLAIM_RE.test(outputLower)) {
      return {
        ok: false,
        code: "missing_successful_tool_evidence",
        message: "Child claims to have created/modified files but made zero tool calls",
      }
    }
  }

  // ── 5. File mutation evidence ──
  if (specRequiresFileMutationEvidence(spec)) {
    const hasMutation = toolCalls.some(tc => isFileMutationToolCall(tc) && !tc.isError)
    if (!hasMutation && toolCalls.length > 0) {
      // Check for shell-based file creation
      const hasShellMutation = toolCalls.some(tc => {
        if (tc.name !== "run_command" && tc.name !== "shell") return false
        const cmd = typeof tc.args.command === "string" ? tc.args.command : ""
        return (SHELL_FILE_WRITE_RE.test(cmd) || SHELL_IN_PLACE_EDIT_RE.test(cmd) || SHELL_SCAFFOLD_RE.test(cmd)) && !tc.isError
      })
      if (!hasShellMutation) {
        return {
          ok: false,
          code: "missing_file_mutation_evidence",
          message: `Contract requires file creation/modification (${spec.targetArtifacts.length} target artifacts) but no file mutation tools were used successfully`,
        }
      }
    }
  }

  // ── 6. Workspace inspection evidence ──
  if (specRequiresWorkspaceInspection(spec) && toolCalls.length > 0) {
    const hasInspection = toolCalls.some(tc => isWorkspaceInspectionToolCall(tc) && !tc.isError)
    if (!hasInspection) {
      return {
        ok: false,
        code: "missing_workspace_inspection_evidence",
        message: "Contract requires workspace inspection (source files listed or reviewer role) but no read/inspection tools were used",
      }
    }
  }

  // ── 7. Required source artifact evidence ──
  if (spec.requiredSourceArtifacts.length > 0 && toolCalls.length > 0) {
    const readPaths = new Set<string>()
    for (const tc of toolCalls) {
      if (FILE_READ_TOOLS.has(tc.name) && !tc.isError) {
        const path = typeof tc.args.path === "string" ? tc.args.path : ""
        if (path) readPaths.add(path)
      }
    }

    // Check that at least some source artifacts were actually read
    const readCount = spec.requiredSourceArtifacts.filter(src => {
      const srcBasename = src.split("/").pop() ?? src
      return [...readPaths].some(rp => rp === src || rp.endsWith(`/${srcBasename}`))
    }).length

    if (readCount === 0 && spec.requiredSourceArtifacts.length > 0) {
      return {
        ok: false,
        code: "missing_required_source_evidence",
        message: `Child was required to read ${spec.requiredSourceArtifacts.length} source files but read none: ${spec.requiredSourceArtifacts.slice(0, 3).join(", ")}`,
      }
    }
  }

  // ── 8. File artifact evidence in output ──
  if (specRequiresFileMutationEvidence(spec) && toolCalls.some(tc => isFileMutationToolCall(tc) && !tc.isError)) {
    // Child used file mutation tools — verify there is artifact evidence either
    // in output text or directly in successful mutation tool-call paths/results.
    const successfulMutations = toolCalls.filter(tc => isFileMutationToolCall(tc) && !tc.isError)
    const hasToolPathEvidence = successfulMutations.some(hasMutationPathEvidence)
    if (!FILE_ARTIFACT_RE.test(trimmed) && !hasToolPathEvidence) {
      return {
        ok: false,
        code: "missing_file_artifact_evidence",
        message: "File mutation tools were used but no artifact path evidence was found in output or tool results",
      }
    }
  }

  // ── 8b. Target artifact coverage + reference integrity ──
  if (isImplementationLike && spec.targetArtifacts.length > 0) {
    const successfulMutations = toolCalls.filter(tc => isFileMutationToolCall(tc) && !tc.isError)
    const mutatedPaths = new Set<string>()
    const unresolvedReferences = new Set<string>()
    let hasUnknownMutationPath = false

    for (const tc of successfulMutations) {
      const pathArg = getToolCallPathArg(tc)
      if (pathArg) {
        mutatedPaths.add(normalizeArtifactPath(pathArg))
      } else {
        hasUnknownMutationPath = true
      }
    }

    const normalizedTargets = spec.targetArtifacts.map(normalizeArtifactPath)
    const touchedTargets = normalizedTargets.filter(target => {
      const targetBase = target.split("/").pop() ?? target
      return [...mutatedPaths].some(mp => mp === target || mp.endsWith(`/${targetBase}`))
    })

    if (successfulMutations.length > 0 && touchedTargets.length === 0 && !hasUnknownMutationPath) {
      return {
        ok: false,
        code: "missing_target_artifact_coverage",
        message: `Mutation tools ran, but none of the declared target artifacts were touched: ${spec.targetArtifacts.slice(0, 3).join(", ")}`,
      }
    }

    const knownArtifacts = new Set<string>([
      ...normalizedTargets,
      ...spec.requiredSourceArtifacts.map(normalizeArtifactPath),
      ...(spec.knownProjectArtifacts ?? []).map(normalizeArtifactPath),
      ...[...mutatedPaths],
    ])

    for (const tc of successfulMutations) {
      const pathArg = getToolCallPathArg(tc)
      const content = typeof tc.args.content === "string" ? tc.args.content : ""
      if (!pathArg || content.length === 0) continue

      const baseDir = normalizeArtifactPath(pathArg).split("/").slice(0, -1).join("/")
      const refs = extractLocalArtifactReferences(content)
      for (const ref of refs) {
        const normalizedRef = normalizeArtifactPath(ref)
        const resolved = normalizedRef.startsWith("../") || normalizedRef.startsWith("./")
          ? normalizeArtifactPath(`${baseDir}/${normalizedRef}`)
          : normalizedRef
        const refBase = resolved.split("/").pop() ?? resolved
        const isKnown = [...knownArtifacts].some(k => k === resolved || k.endsWith(`/${refBase}`))
        if (!isKnown) {
          unresolvedReferences.add(ref)
        }
      }
    }

    const shouldEnforceReferenceIntegrity =
      spec.verificationMode !== "none" || spec.role !== "writer"

    if (unresolvedReferences.size > 0 && shouldEnforceReferenceIntegrity) {
      const sample = [...unresolvedReferences].slice(0, 4).join(", ")
      return {
        ok: false,
        code: "unresolved_artifact_references",
        message: `Created/edited content references local artifacts without evidence they exist: ${sample}`,
      }
    }
  }

  // ── 9. Browser evidence quality ──
  if (specRequiresBrowserEvidence(spec) && toolCalls.length > 0) {
    const browserCalls = toolCalls.filter(tc =>
      MEANINGFUL_BROWSER_TOOLS.has(tc.name) || LOW_SIGNAL_BROWSER_TOOLS.has(tc.name),
    )
    if (browserCalls.length > 0) {
      const hasFailedMeaningfulBrowserEvidence = browserCalls.some((tc) =>
        MEANINGFUL_BROWSER_TOOLS.has(tc.name) && (tc.isError || BROWSER_RUNTIME_FAILURE_RE.test(tc.result)),
      )
      if (hasFailedMeaningfulBrowserEvidence) {
        return {
          ok: false,
          code: "missing_executable_verification_evidence",
          message: "browser_check evidence contains runtime/load errors — fix those errors before claiming completion",
        }
      }

      const allLowSignal = browserCalls.every(tc => isLowSignalBrowserToolCall(tc))
      if (allLowSignal) {
        return {
          ok: false,
          code: "low_signal_browser_evidence",
          message: "Browser tools were used but only low-signal actions (about:blank, tab listing) — no meaningful browser evidence",
        }
      }
    }
  }

  // ── 11. Contradictory completion claim ──
  if (COMPLETION_CLAIM_RE.test(outputLower)) {
    // Check unambiguous markers first
    if (UNRESOLVED_WORK_RE.test(trimmed)) {
      const unresolvedMatch = trimmed.match(UNRESOLVED_WORK_RE)
      return {
        ok: false,
        code: "contradictory_completion_claim",
        message: `Child claims completion but output contains unresolved work: "${unresolvedMatch?.[0]}"`,
      }
    }
    // Check context-sensitive markers (require surrounding context to avoid false positives)
    for (const { re, label } of CONTEXT_SENSITIVE_MARKERS) {
      if (re.test(trimmed)) {
        return {
          ok: false,
          code: "contradictory_completion_claim",
          message: `Child claims completion but output contains unresolved work: "${label}"`,
        }
      }
    }
  }

  // ── 12. Executable verification evidence (implementation tasks) ──
  if (isImplementationLike && specRequiresFileMutationEvidence(spec) && toolCalls.length > 0) {
    const hasVerificationCall = toolCalls.some(tc => !tc.isError && isExecutableVerificationToolCall(tc))
    const hasPostWriteInspection = hasPostMutationArtifactInspection(toolCalls, spec.targetArtifacts)
    if (!hasVerificationCall && !hasPostWriteInspection) {
      return {
        ok: false,
        code: "missing_executable_verification_evidence",
        message: "Implementation output lacks executable verification evidence (runtime/test check or post-write artifact inspection)",
      }
    }
  }

  // ── 13. Acceptance criteria evidence ──
  if (spec.acceptanceCriteria.length > 0) {
    // Implementation tasks must be validated by executable evidence, not
    // narrative token overlap. Keep token checks for non-implementation tasks.
    if (isImplementationLike) {
      return { ok: true }
    }
    const tokens = extractAcceptanceTokens(spec.acceptanceCriteria)
    if (tokens.length > 0) {
      const matchedTokens = tokens.filter(t => outputLower.includes(t))
      // Require at least 20% of acceptance tokens to be mentioned in output
      const coverageRatio = matchedTokens.length / tokens.length
      if (coverageRatio < 0.1 && tokens.length >= 3) {
        return {
          ok: false,
          code: "acceptance_evidence_missing",
          message: `Only ${matchedTokens.length}/${tokens.length} acceptance criteria tokens found in output (coverage: ${(coverageRatio * 100).toFixed(0)}%)`,
        }
      }
    }
  }

  return { ok: true }
}

// ============================================================================
// Correction routing — map validation code to retry guidance
// ============================================================================

/**
 * Get targeted retry guidance for a specific validation failure.
 * This is injected into the child's retry context so it knows exactly
 * what class of fix is needed.
 */
export function getCorrectionGuidance(code: DelegationOutputValidationCode): string {
  switch (code) {
    case "empty_output":
      return "Your previous attempt produced no output. You MUST use tools to accomplish the task and provide a summary of what you did."

    case "empty_structured_payload":
      return "Your previous attempt returned an empty value. You must produce real, substantive output."

    case "acceptance_evidence_missing":
      return "Your previous output didn't mention key acceptance criteria. Re-read the acceptance criteria and ensure your output addresses each one with concrete evidence (file paths, test results, implementation details)."

    case "contradictory_completion_claim":
      return "Your previous output claimed completion but contained TODO/FIXME/PLACEHOLDER markers. You MUST resolve ALL unfinished work before claiming completion. Search your code for TODO, FIXME, PLACEHOLDER, and stub patterns."

    case "missing_file_mutation_evidence":
      return "Your previous attempt didn't create/modify the required files. Use write_file to create the target artifacts. Do NOT just describe what should be done — actually create the files."

    case "missing_successful_tool_evidence":
      return "Your previous attempt claimed to have done work but made no successful tool calls. You MUST use tools (write_file, read_file, run_command) to accomplish the task."

    case "blocked_phase_output":
      return "Your previous attempt reported being blocked or unable to proceed. Try a different approach. If you can't access a resource, work around it. Do NOT report blockage — find a solution."

    case "missing_file_artifact_evidence":
      return "Your previous attempt used file tools but didn't provide clear file-path evidence. Include modified file paths in your output summary and ensure file-tool calls include explicit path arguments."

    case "missing_workspace_inspection_evidence":
      return "Your previous attempt didn't read the required source files. Use read_file to read ALL source files listed in your goal BEFORE making changes."

    case "missing_required_source_evidence":
      return "Your previous attempt skipped reading required source files. You MUST read every file listed in the Source Files section before modifying anything."

    case "all_tools_failed":
      return "All your tool calls failed in the previous attempt. Check your tool arguments (file paths, command syntax) and try again with correct arguments."

    case "low_signal_browser_evidence":
      return "Your browser testing was insufficient — you only checked about:blank or listed tabs. Use browser_check with an actual file path to verify your HTML/JS works."

    case "missing_executable_verification_evidence":
      return "Your previous attempt relied on narrative completion without executable proof. Run deterministic verification (tests/build/runtime checks) or inspect mutated artifacts with read_file before claiming completion."

    case "unresolved_handoff_output":
      return "Your previous output ended in a handoff/partial state. Do NOT ask whether to continue. Complete the implementation end-to-end, verify behavior, and return finished artifacts with evidence."

    case "missing_target_artifact_coverage":
      return "Your previous attempt modified files, but not the declared target artifacts. You MUST create or update the exact target artifacts in your contract and report them in your summary."

    case "unresolved_artifact_references":
      return "Your previous output wrote code that references local files/assets without evidence they exist. Create those referenced artifacts (or update references) before claiming completion."
  }
}

// ============================================================================
// Convenience: build spec from SubagentTaskStep + ExecutionEnvelope
// ============================================================================

/**
 * Build a DelegationContractSpec from a SubagentTaskStep.
 * This is the bridge between the planner types and the validation system.
 */
export function buildContractSpec(
  step: { objective: string; acceptanceCriteria: readonly string[]; requiredToolCapabilities: readonly string[] },
  envelope: { targetArtifacts: readonly string[]; requiredSourceArtifacts: readonly string[]; allowedTools: readonly string[]; effectClass: string; verificationMode: string; role?: string },
  lastValidationCode?: DelegationOutputValidationCode,
  knownProjectArtifacts?: readonly string[],
): DelegationContractSpec {
  return {
    task: step.objective,
    acceptanceCriteria: step.acceptanceCriteria,
    targetArtifacts: envelope.targetArtifacts,
    requiredSourceArtifacts: envelope.requiredSourceArtifacts,
    tools: [
      ...envelope.allowedTools,
      ...step.requiredToolCapabilities,
    ],
    effectClass: envelope.effectClass as DelegationContractSpec["effectClass"],
    verificationMode: envelope.verificationMode,
    role: (envelope.role ?? "writer") as DelegationContractSpec["role"],
    lastValidationCode,
    knownProjectArtifacts,
  }
}
