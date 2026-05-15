/**
 * Delegation + escalation wire enums.
 *
 * Cross HTTP/WS/JSON boundaries: emitted in planner trace events,
 * delegation envelopes, and escalation graph payloads consumed by the
 * UI Operation Log + IOE inspector. Both server and UI compare with
 * `===`, so values MUST match exactly.
 */

/** Action returned by the escalation graph for a step verdict. */
export const EscalationAction = {
  Pass:     "pass",
  Retry:    "retry",
  Revise:   "revise",
  Escalate: "escalate",
} as const

export type EscalationAction = (typeof EscalationAction)[keyof typeof EscalationAction]

export const ESCALATION_ACTION_VALUES: ReadonlyArray<EscalationAction> = Object.values(EscalationAction)

export const isEscalationAction = (value: unknown): value is EscalationAction =>
  typeof value === "string" && (ESCALATION_ACTION_VALUES as readonly string[]).includes(value)

/** Reason code returned alongside an `EscalationAction`. */
export const EscalationReason = {
  Pass:                  "pass",
  RetryAllowed:          "retry_allowed",
  NeedsRevision:         "needs_revision",
  RetriesExhausted:      "retries_exhausted",
  RevisionUnavailable:   "revision_unavailable",
  DisagreementThreshold: "disagreement_threshold",
  Timeout:               "timeout",
  BudgetExhausted:       "budget_exhausted",
  AllStepsStuck:         "all_steps_stuck",
} as const

export type EscalationReason = (typeof EscalationReason)[keyof typeof EscalationReason]

export const ESCALATION_REASON_VALUES: ReadonlyArray<EscalationReason> = Object.values(EscalationReason)

export const isEscalationReason = (value: unknown): value is EscalationReason =>
  typeof value === "string" && (ESCALATION_REASON_VALUES as readonly string[]).includes(value)

/**
 * Side-effect classification for a delegated subagent's contract.
 * Drives validation gates (e.g. shell-write evidence required for
 * `Shell` and `FilesystemWrite`). Surfaced in delegation envelopes
 * shipped to the UI inspector.
 */
export const EffectClass = {
  Readonly:           "readonly",
  FilesystemWrite:    "filesystem_write",
  FilesystemScaffold: "filesystem_scaffold",
  Shell:              "shell",
  Mixed:              "mixed",
} as const

export type EffectClass = (typeof EffectClass)[keyof typeof EffectClass]

export const EFFECT_CLASS_VALUES: ReadonlyArray<EffectClass> = Object.values(EffectClass)

export const isEffectClass = (value: unknown): value is EffectClass =>
  typeof value === "string" && (EFFECT_CLASS_VALUES as readonly string[]).includes(value)

/** Terminal status of a (planner-)delegation invocation. */
export const DelegationEndStatus = {
  Done:  "done",
  Error: "error",
} as const

export type DelegationEndStatus = (typeof DelegationEndStatus)[keyof typeof DelegationEndStatus]

export const DELEGATION_END_STATUS_VALUES: ReadonlyArray<DelegationEndStatus> = Object.values(DelegationEndStatus)

export const isDelegationEndStatus = (value: unknown): value is DelegationEndStatus =>
  typeof value === "string" && (DELEGATION_END_STATUS_VALUES as readonly string[]).includes(value)
