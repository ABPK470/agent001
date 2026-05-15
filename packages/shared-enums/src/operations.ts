/**
 * Server-exposed operation history enums consumed by the UI Operation Log.
 *
 * Wire-format: returned in `/api/operations` JSON and streamed in
 * `/api/operations/stream` SSE payloads. Both server and UI compare
 * with `===`, so values MUST match exactly.
 */

/** Top-level operation kind exposed via /api/operations. */
export const OperationKind = {
  AgentRun:    "agent-run",
  SyncPreview: "sync-preview",
  SyncExecute: "sync-execute",
  System:      "system",
} as const

export type OperationKind = (typeof OperationKind)[keyof typeof OperationKind]

export const OPERATION_KINDS: ReadonlyArray<OperationKind> = Object.values(OperationKind)

export const isOperationKind = (value: unknown): value is OperationKind =>
  typeof value === "string" && (OPERATION_KINDS as readonly string[]).includes(value)

/** Operation lifecycle status (the original `inferPipelineStatus` codomain). */
export const OperationStatus = {
  Running:   "running",
  Success:   "success",
  Failed:    "failed",
  Cancelled: "cancelled",
  Unknown:   "unknown",
} as const

export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus]

export const OPERATION_STATUSES: ReadonlyArray<OperationStatus> = Object.values(OperationStatus)

export const isOperationStatus = (value: unknown): value is OperationStatus =>
  typeof value === "string" && (OPERATION_STATUSES as readonly string[]).includes(value)
