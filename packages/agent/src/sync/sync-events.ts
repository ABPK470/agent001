/**
 * Sync subsystem event/log plumbing.
 *
 * Two concerns, one file (they share a sink):
 *
 *   1. Lifecycle events  — `sync.preview.*`, `sync.execute.*`. Emitted from
 *      the orchestrator at semantic boundaries (start, table done, completed).
 *      Cardinality: ~10 events per preview. Always emitted.
 *
 *   2. SQL query events  — `sync.preview.sql` / `sync.execute.sql`. Emitted
 *      from the diff/execute SQL helpers with an explicit trace context so
 *      each query is attributed to its previewId/planId without ambient
 *      state. Cardinality: ~3-5 queries per table per op
 *      (~30-50 events per preview). Always emitted to the event stream;
 *      the SQL text is truncated to keep `event_log` rows compact.
 *
 * Why both go through one sink: it lets the server wire a single
 * `setSyncEventSink(broadcast)` and have everything land in the same place
 * (SSE clients, event_log table, webhook drains). No second pipe.
 *
 * The agent package can't import server-side `broadcast()` directly (that
 * would create a cycle), so the server injects the sink at startup.
 */

import { EventType } from "../domain/enums/event.js"
import { SyncOperationType } from "../domain/enums/sync.js"
import type { AgentHost } from "../host/index.js"

export type SyncEvent = { type: EventType; data: Record<string, unknown> }
export type SyncEventSink = (event: SyncEvent) => void

// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape until this sync state is moved fully behind the host surface.

/** Server installs this once at startup (see server/src/index.ts). */
export function setSyncEventSink(host: AgentHost, sink: SyncEventSink): void {
  host.sync.eventSink = sink
}

/** Fire-and-forget emit. Sink errors NEVER propagate.
 *  Reads the sink off the supplied host. */
export function emitSyncEvent(host: AgentHost, type: EventType, data: Record<string, unknown>): void {
  try { host.sync.eventSink({ type, data }) } catch (e) {
    console.error(`[sync.event] sink failed for ${type}:`, e)
  }
}

// ── Per-operation SQL trace context ─────────────────────────────

export interface SyncSqlTraceContext {
  /** "preview" or "execute" — sets the event-type prefix. */
  kind: SyncOperationType
  /** Correlation key — previewId for preview, planId for execute. */
  opId: string
  /** Optional source/target connection names for richer event payloads. */
  source?: string
  target?: string
}

// ── SQL event helper ────────────────────────────────────────────

/**
 * SQL text in event payloads is truncated. Full text always goes to the
 * server console (gated by SYNC_DEBUG_SQL=1) — the event stream is for
 * "what queries fired and how long did they take", not for storing every
 * 50KB hash query verbatim in SQLite.
 */
const SQL_EVENT_MAX_CHARS = 2_000

export interface SqlEventInput {
  /** Logical name e.g. "fetchPkHash(core.Contract)". */
  label: string
  /** mssql connection name the query ran against. */
  connection: string
  /** Full SQL text — will be truncated for the event payload. */
  sql: string
  /** Wall-clock ms for the query (across all retries). */
  durationMs: number
  /** Row count returned, when known. */
  rowCount?: number
  /** Number of attempts made (1 = no retry). */
  attempts: number
  /** Final error message if the query ultimately failed. */
  error?: string
}

export function emitSyncSqlEvent(host: AgentHost, input: SqlEventInput, ctx: SyncSqlTraceContext | null = null): void {
  const prefix = ctx?.kind ?? SyncOperationType.Preview
  const truncated = input.sql.length > SQL_EVENT_MAX_CHARS
    ? input.sql.slice(0, SQL_EVENT_MAX_CHARS) + `… [+${input.sql.length - SQL_EVENT_MAX_CHARS} chars]`
    : input.sql
  emitSyncEvent(host, prefix === SyncOperationType.Execute ? EventType.SyncExecuteSql : EventType.SyncPreviewSql, {
    opId: ctx?.opId ?? null,
    label: input.label,
    connection: input.connection,
    durationMs: input.durationMs,
    rowCount: input.rowCount ?? null,
    attempts: input.attempts,
    error: input.error ?? null,
    sql: truncated,
    sqlLength: input.sql.length,
  })

  if (process.env["SYNC_DEBUG_SQL"] === "1") {
    const status = input.error ? `FAIL: ${input.error}` : `${input.rowCount ?? "?"} rows in ${input.durationMs}ms`
    console.log(`[sync.sql] ${input.connection} ${input.label} (${status})\n${input.sql}\n`)
  }
}
