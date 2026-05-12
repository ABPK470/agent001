/**
 * Validation taxonomy + shared regex/sets used by the gate functions.
 *
 * @module
 */

import type { ToolCallRecord } from "../tool-result.js"

export const DELEGATION_OUTPUT_VALIDATION_CODES = [
  "empty_output",
  "empty_structured_payload",
  "acceptance_evidence_missing",
  "contradictory_completion_claim",
  "missing_file_mutation_evidence",
  "missing_successful_tool_evidence",
  "blocked_phase_output",
  "missing_file_artifact_evidence",
  "missing_workspace_inspection_evidence",
  "missing_required_source_evidence",
  "all_tools_failed",
  "low_signal_browser_evidence",
  "missing_executable_verification_evidence",
  "unresolved_handoff_output",
  "missing_target_artifact_coverage",
  "unresolved_artifact_references",
] as const

export type DelegationOutputValidationCode =
  typeof DELEGATION_OUTPUT_VALIDATION_CODES[number]

export interface DelegationContractSpec {
  readonly task: string
  readonly acceptanceCriteria: readonly string[]
  readonly targetArtifacts: readonly string[]
  readonly requiredSourceArtifacts: readonly string[]
  readonly tools: readonly string[]
  readonly effectClass: "readonly" | "filesystem_write" | "filesystem_scaffold" | "shell" | "mixed"
  readonly verificationMode: string
  readonly role: "writer" | "reviewer" | "validator" | "grounding"
  readonly lastValidationCode?: DelegationOutputValidationCode
  readonly knownProjectArtifacts?: readonly string[]
}

export interface DelegationOutputValidationResult {
  readonly ok: boolean
  readonly code?: DelegationOutputValidationCode
  readonly message?: string
}

/** Common parameter pack passed to every gate. */
export interface GateParams {
  readonly spec: DelegationContractSpec
  readonly output: string
  readonly trimmed: string
  readonly outputLower: string
  readonly toolCalls: readonly ToolCallRecord[]
}

// ── Tool/command constants ──────────────────────────────────────

export const FILE_READ_TOOLS = new Set([
  "read_file", "list_directory", "search_files",
])

export const SHELL_FILE_WRITE_RE =
  /\b(?:tee|touch|cp|mv|install)\b|\bcat\b[^\n]*\s(?:>|>>|<<)\s*\S|(?:^|[^>])>{1,2}\s*\S/i
export const SHELL_IN_PLACE_EDIT_RE =
  /\b(?:sed|perl|ruby)\b(?:(?![|;&\n]).)*\s-(?:[A-Za-z]*i|pi)(?:\b|=|['"])/i
export const SHELL_SCAFFOLD_RE =
  /\b(?:npm\s+(?:create|init)|pnpm\s+(?:create|init)|yarn\s+create|bun\s+create|cargo\s+(?:new|init)|git\s+clone)\b/i

export const LOW_SIGNAL_BROWSER_TOOLS = new Set<string>([
  // Reserved for future browser sub-tools
])
