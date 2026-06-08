/**
 * Delegation + tool-loop enums — single source of truth for tool
 * orchestration, escalation, and bandit decisions.
 *
 * Wire enums (cross agent↔server↔UI) are owned by `@mia/shared-enums`
 * and re-exported here so existing `from "@mia/agent"` imports keep
 * working. Internal enums (no wire crossing) are declared inline below
 * using the canonical `as const` pattern (see `@mia/shared-enums` for the
 * same shape applied to wire enums):
 *   - `export const X = { Foo: "foo", … } as const`
 *   - `export type X = (typeof X)[keyof typeof X]`
 *   - `export const X_VALUES: ReadonlyArray<X> = Object.values(X)`
 *   - `export const isX = (v): v is X => …`
 */

// ── Wire enums (canonical source: @mia/shared-enums) ──────────

export {
  DELEGATION_END_STATUS_VALUES,
  DelegationEndStatus,
  EFFECT_CLASS_VALUES,
  EffectClass,
  ESCALATION_ACTION_VALUES,
  ESCALATION_REASON_VALUES,
  EscalationAction,
  EscalationReason,
  isDelegationEndStatus,
  isEffectClass,
  isEscalationAction,
  isEscalationReason
} from "@mia/shared-enums"

// ─── ToolOutcomeSeverity ───────────────────────────────────────────────
export const ToolOutcomeSeverity = {
  Info: "info",
  Recoverable: "recoverable",
  Fatal: "fatal"
} as const

export type ToolOutcomeSeverity = (typeof ToolOutcomeSeverity)[keyof typeof ToolOutcomeSeverity]
export const TOOL_OUTCOME_SEVERITY_VALUES: ReadonlyArray<ToolOutcomeSeverity> =
  Object.values(ToolOutcomeSeverity)
export const isToolOutcomeSeverity = (value: unknown): value is ToolOutcomeSeverity =>
  typeof value === "string" && (TOOL_OUTCOME_SEVERITY_VALUES as readonly string[]).includes(value)

// ─── ToolControlDirective ─────────────────────────────────────────────
export const ToolControlDirective = {
  Continue: "continue",
  RetryAfterInspection: "retry_after_inspection",
  AbortRound: "abort_round",
  AbortLoop: "abort_loop"
} as const

export type ToolControlDirective = (typeof ToolControlDirective)[keyof typeof ToolControlDirective]
export const TOOL_CONTROL_DIRECTIVE_VALUES: ReadonlyArray<ToolControlDirective> =
  Object.values(ToolControlDirective)
export const isToolControlDirective = (value: unknown): value is ToolControlDirective =>
  typeof value === "string" && (TOOL_CONTROL_DIRECTIVE_VALUES as readonly string[]).includes(value)

// ─── ToolCallAction ───────────────────────────────────────────────────
export const ToolCallAction = {
  Processed: "processed",
  Skip: "skip",
  EndRound: "end_round",
  AbortRound: "abort_round",
  AbortLoop: "abort_loop"
} as const

export type ToolCallAction = (typeof ToolCallAction)[keyof typeof ToolCallAction]
export const TOOL_CALL_ACTION_VALUES: ReadonlyArray<ToolCallAction> = Object.values(ToolCallAction)
export const isToolCallAction = (value: unknown): value is ToolCallAction =>
  typeof value === "string" && (TOOL_CALL_ACTION_VALUES as readonly string[]).includes(value)

// ─── TaskIntent ───────────────────────────────────────────────────────
export const TaskIntent = {
  Research: "research",
  Implementation: "implementation",
  Validation: "validation",
  Documentation: "documentation",
  Mixed: "mixed"
} as const

export type TaskIntent = (typeof TaskIntent)[keyof typeof TaskIntent]
export const TASK_INTENT_VALUES: ReadonlyArray<TaskIntent> = Object.values(TaskIntent)
export const isTaskIntent = (value: unknown): value is TaskIntent =>
  typeof value === "string" && (TASK_INTENT_VALUES as readonly string[]).includes(value)

// ─── EscalationAction + EscalationReason re-exported above (wire enums) ───

// ─── BanditArmId ──────────────────────────────────────────────────────
export const BanditArmId = {
  Conservative: "conservative",
  Balanced: "balanced",
  Aggressive: "aggressive"
} as const

export type BanditArmId = (typeof BanditArmId)[keyof typeof BanditArmId]
export const BANDIT_ARM_ID_VALUES: ReadonlyArray<BanditArmId> = Object.values(BanditArmId)
export const isBanditArmId = (value: unknown): value is BanditArmId =>
  typeof value === "string" && (BANDIT_ARM_ID_VALUES as readonly string[]).includes(value)

// ─── DelegationHardBlockedMatchSource ─────────────────────────────────
export const DelegationHardBlockedMatchSource = {
  Capability: "capability",
  Text: "text"
} as const

export type DelegationHardBlockedMatchSource =
  (typeof DelegationHardBlockedMatchSource)[keyof typeof DelegationHardBlockedMatchSource]
export const DELEGATION_HARD_BLOCKED_MATCH_SOURCE_VALUES: ReadonlyArray<DelegationHardBlockedMatchSource> =
  Object.values(DelegationHardBlockedMatchSource)
export const isDelegationHardBlockedMatchSource = (
  value: unknown
): value is DelegationHardBlockedMatchSource =>
  typeof value === "string" &&
  (DELEGATION_HARD_BLOCKED_MATCH_SOURCE_VALUES as readonly string[]).includes(value)

// ─── EscalationReason / EffectClass — re-exported from @mia/shared-enums (wire enums) ─

// ─── DelegationRole ───────────────────────────────────────────────────
//
// Role a subagent plays inside a delegation contract. Distinct from
// StepRole (planner-pipeline level) — though the values overlap today,
// they are separate domains and may diverge.
export const DelegationRole = {
  Writer: "writer",
  Reviewer: "reviewer",
  Validator: "validator",
  Grounding: "grounding"
} as const

export type DelegationRole = (typeof DelegationRole)[keyof typeof DelegationRole]
export const DELEGATION_ROLE_VALUES: ReadonlyArray<DelegationRole> = Object.values(DelegationRole)
export const isDelegationRole = (value: unknown): value is DelegationRole =>
  typeof value === "string" && (DELEGATION_ROLE_VALUES as readonly string[]).includes(value)

// ─── DelegationOutputValidationCode ───────────────────────────────────
//
// Validation gate failure codes returned by the delegation output checker.
// 16 codes; ORDER PRESERVED to match the historical
// `DELEGATION_OUTPUT_VALIDATION_CODES` array (some callers iterate it for
// taxonomy reporting). Switch statements over `code` get exhaustiveness
// checking from the derived union type.
export const DelegationOutputValidationCode = {
  EmptyOutput: "empty_output",
  EmptyStructuredPayload: "empty_structured_payload",
  AcceptanceEvidenceMissing: "acceptance_evidence_missing",
  ContradictoryCompletionClaim: "contradictory_completion_claim",
  MissingFileMutationEvidence: "missing_file_mutation_evidence",
  MissingSuccessfulToolEvidence: "missing_successful_tool_evidence",
  BlockedPhaseOutput: "blocked_phase_output",
  MissingFileArtifactEvidence: "missing_file_artifact_evidence",
  MissingWorkspaceInspectionEvidence: "missing_workspace_inspection_evidence",
  MissingRequiredSourceEvidence: "missing_required_source_evidence",
  AllToolsFailed: "all_tools_failed",
  LowSignalBrowserEvidence: "low_signal_browser_evidence",
  MissingExecutableVerificationEvidence: "missing_executable_verification_evidence",
  UnresolvedHandoffOutput: "unresolved_handoff_output",
  MissingTargetArtifactCoverage: "missing_target_artifact_coverage",
  UnresolvedArtifactReferences: "unresolved_artifact_references"
} as const

export type DelegationOutputValidationCode =
  (typeof DelegationOutputValidationCode)[keyof typeof DelegationOutputValidationCode]
export const DELEGATION_OUTPUT_VALIDATION_CODE_VALUES: ReadonlyArray<DelegationOutputValidationCode> =
  Object.values(DelegationOutputValidationCode)
export const isDelegationOutputValidationCode = (value: unknown): value is DelegationOutputValidationCode =>
  typeof value === "string" && (DELEGATION_OUTPUT_VALIDATION_CODE_VALUES as readonly string[]).includes(value)
