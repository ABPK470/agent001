/**
 * Agent-runtime / human-in-the-loop discriminator enums.
 *
 * Single source of truth for the visible-browser handoff request reason
 * and the resolution status returned to the caller.
 *
 * @module
 */

// ── HumanHandoffReason ──────────────────────────────────────────────────
export const HumanHandoffReason = {
  Captcha: "captcha",
  TwoFA:   "2fa",
  Manual:  "manual",
} as const

export type HumanHandoffReason = (typeof HumanHandoffReason)[keyof typeof HumanHandoffReason]

export const HUMAN_HANDOFF_REASON_VALUES: ReadonlyArray<HumanHandoffReason> =
  Object.values(HumanHandoffReason)

export const isHumanHandoffReason = (value: unknown): value is HumanHandoffReason =>
  typeof value === "string" &&
  (HUMAN_HANDOFF_REASON_VALUES as readonly string[]).includes(value)

// ── UserInputStatus ─────────────────────────────────────────────────────
export const UserInputStatus = {
  Completed: "completed",
  Expired:   "expired",
  Revoked:   "revoked",
} as const

export type UserInputStatus = (typeof UserInputStatus)[keyof typeof UserInputStatus]

export const USER_INPUT_STATUS_VALUES: ReadonlyArray<UserInputStatus> =
  Object.values(UserInputStatus)

export const isUserInputStatus = (value: unknown): value is UserInputStatus =>
  typeof value === "string" &&
  (USER_INPUT_STATUS_VALUES as readonly string[]).includes(value)
