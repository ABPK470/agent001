/**
 * Sync subsystem event/log plumbing.
 */

import { EventType, SyncOperationType } from "../domain/enums.js"
import type { SqlEventInput, SyncEventSink, SyncTelemetryContext } from "../ports/events.js"
import type { SyncEventHost } from "../ports/host.js"
import { resolveSyncSqlEventType } from "./sql-event-type.js"

export type { SqlEventInput, SyncEvent, SyncEventSink, SyncTelemetryContext } from "../ports/events.js"

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
  const eventType = resolveSyncSqlEventType(ctx)
  const planId = ctx?.planId ?? (ctx?.kind === SyncOperationType.Execute ? ctx?.opId : null)
  const previewId =
    ctx?.previewId ?? (ctx?.kind === SyncOperationType.Preview ? ctx?.opId : null)
  const truncated =
    input.sql.length > SQL_EVENT_MAX_CHARS
      ? input.sql.slice(0, SQL_EVENT_MAX_CHARS) + `… [+${input.sql.length - SQL_EVENT_MAX_CHARS} chars]`
      : input.sql
  emitSyncEvent(host, eventType, {
    opId: ctx?.opId ?? null,
    planId: planId ?? null,
    previewId: previewId ?? null,
    scope: ctx?.scope ?? null,
    label: input.label,
    connection: input.connection,
    durationMs: input.durationMs,
    rowCount: input.rowCount ?? null,
    attempts: input.attempts,
    error: input.error ?? null,
    sql: truncated,
    sqlLength: input.sql.length,
    __fullSql: input.sql,
  })

  if (process.env["SYNC_DEBUG_SQL"] === "1") {
    const status = input.error
      ? `FAIL: ${input.error}`
      : `${input.rowCount ?? "?"} rows in ${input.durationMs}ms`
    console.log(`[sync.sql] ${input.connection} ${input.label} (${status})\n${input.sql}\n`)
  }
}

export interface HttpEventInput {
  planId: string
  step: string
  method: string
  url: string
  status: number
  durationMs: number
  requestBody?: Record<string, unknown> | null
  responseBody?: Record<string, unknown> | null
  error?: string | null
}

function truncateJsonValue(value: unknown): unknown {
  if (value == null) return value
  const raw = JSON.stringify(value)
  if (raw.length <= SQL_EVENT_MAX_CHARS) return value
  return {
    __truncated: true,
    preview: raw.slice(0, SQL_EVENT_MAX_CHARS),
    length: raw.length,
  }
}

/** Peer of emitSyncSqlEvent — HTTP flow-step request/response for Pipelines detail. */
export function emitSyncHttpEvent(host: SyncEventHost, input: HttpEventInput): void {
  emitSyncEvent(host, EventType.SyncExecuteHttp, {
    planId: input.planId,
    step: input.step,
    method: input.method,
    url: input.url,
    status: input.status,
    durationMs: input.durationMs,
    requestBody: truncateJsonValue(input.requestBody ?? null),
    responseBody: truncateJsonValue(input.responseBody ?? null),
    error: input.error ?? null,
  })
}
