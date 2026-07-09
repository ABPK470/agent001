import type { SyncExecuteProgress } from "../../types"

/**
 * Whether an execute progress event belongs in the human-readable audit log.
 *
 * Deploy steps emit a `started` tick for live progress (bar + current step) and a
 * terminal `done` / `failed` / `skipped` tick with the outcome. Only terminal
 * deploy events are log rows — otherwise every post-metadata step appears twice.
 */
export function isExecAuditLogEvent(event: SyncExecuteProgress): boolean {
  if (event.type === "deploy-step" && event.deployStatus === "started") return false
  return true
}

/** Audit-log rows for the execute modal — full telemetry stream minus in-flight deploy ticks. */
export function execAuditLogEvents(events: readonly SyncExecuteProgress[]): SyncExecuteProgress[] {
  return events.filter(isExecAuditLogEvent)
}
