/**
 * Sync subsystem event/log plumbing.
 */

import { EventType, SyncOperationType } from "../../domain/enums.js"
import type { SqlEventInput, SyncEventSink, SyncTelemetryContext } from "../../ports/events.js"
import type { SyncEventHost } from "../../ports/host.js"

export type { SqlEventInput, SyncEvent, SyncEventSink, SyncTelemetryContext } from "../../ports/events.js"

const SQL_EVENT_MAX_CHARS = 2_000

export function configureSyncEventSink(host: SyncEventHost, sink: SyncEventSink): void {
  host.sync.events.sink = sink
}

export function emitSyncEvent(host: SyncEventHost, type: EventType, data: Record<string, unknown>): void {
  try {
    host.sync.events.sink({ type, data })
  } catch (e) {
    console.error(`[sync.event] sink failed for ${type}:`, e)
  }
}

export function emitSyncSqlEvent(
  host: SyncEventHost,
  input: SqlEventInput,
  context?: SyncTelemetryContext
): void {
  const ctx = context
  const prefix = ctx?.kind ?? SyncOperationType.Preview
  const truncated =
    input.sql.length > SQL_EVENT_MAX_CHARS
      ? input.sql.slice(0, SQL_EVENT_MAX_CHARS) + `… [+${input.sql.length - SQL_EVENT_MAX_CHARS} chars]`
      : input.sql
  emitSyncEvent(
    host,
    prefix === SyncOperationType.Execute ? EventType.SyncExecuteSql : EventType.SyncPreviewSql,
    {
      opId: ctx?.opId ?? null,
      label: input.label,
      connection: input.connection,
      durationMs: input.durationMs,
      rowCount: input.rowCount ?? null,
      attempts: input.attempts,
      error: input.error ?? null,
      sql: truncated,
      sqlLength: input.sql.length
    }
  )

  if (process.env["SYNC_DEBUG_SQL"] === "1") {
    const status = input.error
      ? `FAIL: ${input.error}`
      : `${input.rowCount ?? "?"} rows in ${input.durationMs}ms`
    console.log(`[sync.sql] ${input.connection} ${input.label} (${status})\n${input.sql}\n`)
  }
}
