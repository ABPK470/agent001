/**
 * Server-only enums for the `browser` domain.
 */

/** Browser navigation gate decision for audit logging. */
export const BrowserDecision = {
  Allow: "allow",
  Deny: "deny",
  Captcha: "captcha",
  Error: "error"
} as const

export type BrowserDecision = (typeof BrowserDecision)[keyof typeof BrowserDecision]

export const BROWSER_DECISIONS: ReadonlyArray<BrowserDecision> = Object.values(BrowserDecision)

export const isBrowserDecision = (value: unknown): value is BrowserDecision =>
  typeof value === "string" && (BROWSER_DECISIONS as readonly string[]).includes(value)

// ── HandoffStatus ────────────────────────────────────────────────────────
//
// Server-side lifecycle state of a visible-browser handoff record.
// Superset of the agent's `UserInputStatus` (which sees only the three
// resolved values returned to the agent). The extra `Pending` state
// lives only on the server side while the user is still working.
export const HandoffStatus = {
  Pending: "pending",
  Completed: "completed",
  Expired: "expired",
  Revoked: "revoked"
} as const

export type HandoffStatus = (typeof HandoffStatus)[keyof typeof HandoffStatus]

export const HANDOFF_STATUSES: ReadonlyArray<HandoffStatus> = Object.values(HandoffStatus)

export const isHandoffStatus = (value: unknown): value is HandoffStatus =>
  typeof value === "string" && (HANDOFF_STATUSES as readonly string[]).includes(value)
