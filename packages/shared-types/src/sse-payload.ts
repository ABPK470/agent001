/**
 * Platform wire-field accessors — SSE and tool args use camelCase JSON keys.
 *
 * Sync handler configuration uses {@link ValueSource} in shared-types — not string grammars.
 */

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function readStringOrNumberId(value: unknown): string | undefined {
  const asString = readNonEmptyString(value)
  if (asString != null) return asString
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

/** SSE / DomainEvent: `stepId`. */
export function readSseStepId(data: Record<string, unknown>): string | undefined {
  return readNonEmptyString(data["stepId"])
}

/** SSE / DomainEvent: `runId`. */
export function readSseRunId(data: Record<string, unknown>): string | undefined {
  return readNonEmptyString(data["runId"])
}

/** SSE / DomainEvent: `entityId` (string or numeric id). */
export function readSseEntityId(data: Record<string, unknown>): string | undefined {
  return readStringOrNumberId(data["entityId"])
}

/** SSE / DomainEvent: `toolCallId`. */
export function readSseToolCallId(data: Record<string, unknown>): string | undefined {
  return readNonEmptyString(data["toolCallId"])
}

/** SSE / DomainEvent: `toolName`. */
export function readSseToolName(data: Record<string, unknown>): string | undefined {
  return readNonEmptyString(data["toolName"])
}

/** Tool args: `entityId` (sync_preview, sync_diff_scan, …). */
export function readToolEntityId(args: Record<string, unknown>): string {
  return readStringOrNumberId(args["entityId"]) ?? ""
}

/** Dedupe key fragment for step-scoped SSE events. */
export function sseStepDedupeToken(data: Record<string, unknown>): string {
  return readSseStepId(data) ?? ""
}
