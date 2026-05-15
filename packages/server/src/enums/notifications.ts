/**
 * Notification enums (server-side toast / inbox actions).
 *
 * `NotificationActionType` discriminates the action a UI button on a
 * notification should perform when clicked. Single source of truth for
 * the action set used by `createNotification({ actions: [...] })`.
 *
 * @module
 */

export const NotificationActionType = {
  ViewRun:      "view-run",
  RollbackRun:  "rollback-run",
  ResumeRun:    "resume-run",
  ApplyRunDiff: "apply-run-diff",
  CancelRun:    "cancel-run",
  OpenPolicies: "open-policies",
} as const

export type NotificationActionType = (typeof NotificationActionType)[keyof typeof NotificationActionType]

export const NOTIFICATION_ACTION_TYPES: ReadonlyArray<NotificationActionType> = Object.values(NotificationActionType)

export const isNotificationActionType = (value: unknown): value is NotificationActionType =>
  typeof value === "string" && (NOTIFICATION_ACTION_TYPES as readonly string[]).includes(value)
