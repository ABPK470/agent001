/**
 * Validation taxonomy + shared regex/sets used by the gate functions.
 *
 * @module
 */

import {
  DELEGATION_OUTPUT_VALIDATION_CODE_VALUES,
  DelegationOutputValidationCode,
  DelegationRole,
  EffectClass
} from "../../../domain/enums/delegation.js"
import { VerificationMode } from "../../../domain/enums/planner.js"
import type { ToolCallRecord } from "../../../tools/index.js"
export { DelegationOutputValidationCode, DelegationRole, EffectClass, VerificationMode }

/**
 * Legacy alias — historical name kept for callers that iterate the value
 * list (taxonomy reporting, telemetry, etc.). Prefer the canonical
 * `DELEGATION_OUTPUT_VALIDATION_CODE_VALUES` re-export from
 * `engine/enums/delegation` going forward.
 */
export const DELEGATION_OUTPUT_VALIDATION_CODES: ReadonlyArray<DelegationOutputValidationCode> =
  DELEGATION_OUTPUT_VALIDATION_CODE_VALUES

export interface DelegationContractSpec {
  readonly task: string
  readonly acceptanceCriteria: readonly string[]
  readonly targetArtifacts: readonly string[]
  readonly requiredSourceArtifacts: readonly string[]
  readonly tools: readonly string[]
  readonly effectClass: EffectClass
  readonly verificationMode: VerificationMode
  readonly role: DelegationRole
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

export const FILE_READ_TOOLS = new Set(["read_file", "list_directory", "search_files"])

export const SHELL_FILE_WRITE_RE =
  /\b(?:tee|touch|cp|mv|install)\b|\bcat\b[^\n]*\s(?:>|>>|<<)\s*\S|(?:^|[^>])>{1,2}\s*\S/i
export const SHELL_IN_PLACE_EDIT_RE =
  /\b(?:sed|perl|ruby)\b(?:(?![|;&\n]).)*\s-(?:[A-Za-z]*i|pi)(?:\b|=|['"])/i
export const SHELL_SCAFFOLD_RE =
  /\b(?:npm\s+(?:create|init)|pnpm\s+(?:create|init)|yarn\s+create|bun\s+create|cargo\s+(?:new|init)|git\s+clone)\b/i

export const LOW_SIGNAL_BROWSER_TOOLS = new Set<string>([
  // Reserved for future browser sub-tools
])
