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
 *      from the diff/execute SQL helpers via AsyncLocalStorage so any query
 *      run inside a `runWithSyncContext()` scope is automatically attributed
 *      to its previewId/planId. Cardinality: ~3-5 queries per table per op
 *      (~30-50 events per preview). Always emitted to the event stream;
 *      the SQL text is truncated to keep `event_log` rows compact.
 *
 * Why both go through one sink: it lets the server wire a single
 * `setSyncEventSink(broadcast)` and have everything land in the same place
 * (WS/SSE clients, event_log table, webhook drains). No second pipe.
 *
 * The agent package can't import server-side `broadcast()` directly (that
 * would create a cycle), so the server injects the sink at startup.
 */

import { AsyncLocalStorage } from "node:async_hooks"
import { currentRuntime } from "../agent-runtime.js";

export type SyncEvent = { type: string; data: Record<string, unknown> }
export type SyncEventSink = (event: SyncEvent) => void

// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape. The state can be migrated into AgentRuntime sub-runtimes later.

/** Server installs this once at startup (see server/src/index.ts). */
export function setSyncEventSink(sink: SyncEventSink): void {
  currentRuntime().sync.eventSink = sink
}

/** Fire-and-forget emit. Sink errors NEVER propagate. */
export function emitSyncEvent(type: string, data: Record<string, unknown>): void {
  try { currentRuntime().sync.eventSink({ type, data }) } catch (e) {
    console.error(`[sync.event] sink failed for ${type}:`, e)
  }
}

// ── Per-operation context (AsyncLocalStorage) ───────────────────
//
// Threaded through previewSync / executeSync so deep helpers
// (diff-engine, sample readers) can attribute their SQL events to the
// correct previewId/planId without having to plumb the id through every
// function signature.

export interface SyncOpContext {
  /** "preview" or "execute" — sets the event-type prefix. */
  kind: "preview" | "execute"
  /** Correlation key — previewId for preview, planId for execute. */
  opId: string
  /** Optional source/target connection names for richer event payloads. */
  source?: string
  target?: string
}

const _opContext = new AsyncLocalStorage<SyncOpContext>()

export function runWithSyncContext<T>(ctx: SyncOpContext, fn: () => Promise<T>): Promise<T> {
  return _opContext.run(ctx, fn)
}

export function getSyncContext(): SyncOpContext | undefined {
  return _opContext.getStore()
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

export function emitSyncSqlEvent(input: SqlEventInput): void {
  const ctx = getSyncContext()
  const prefix = ctx?.kind ?? "preview"
  const truncated = input.sql.length > SQL_EVENT_MAX_CHARS
    ? input.sql.slice(0, SQL_EVENT_MAX_CHARS) + `… [+${input.sql.length - SQL_EVENT_MAX_CHARS} chars]`
    : input.sql
  emitSyncEvent(`sync.${prefix}.sql`, {
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
