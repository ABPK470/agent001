/**
 * Internal DB plumbing shared across the sync orchestrator modules.
 *
 * Contains the project-root configuration state, parallelism cap,
 * identifier quoting, SQL literal coercion, and the SQL-telemetry
 * wrappers (`trackedQuery` / `trackedExecute`) that emit
 * `sync.<kind>.sql` events for every query in the execute path.
 *
 * @module
 */

import type sql from "mssql"
import { emitSyncSqlEvent } from "../sync-events.js"

/**
 * Hard ceiling on how many tables diff in parallel. The mssql pool defaults
 * to max=10 connections per pool; with src+tgt+samples queries each table
 * burns 3-5 conns. Going wider than this exhausts the pool, queues requests,
 * and triggers `Connection is closed` cascades. Override via env if needed.
 */
export const PREVIEW_TABLE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env["SYNC_PREVIEW_CONCURRENCY"] ?? "4", 10) || 4,
)

/** Maximum tolerated drift between preview and current source row counts. */
export const DRIFT_ABORT_PCT = 0.05

// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape. The state can be migrated into AgentRuntime sub-runtimes later.
const _state: { projectRoot: string | null } = { projectRoot: null }

/** Configure the project root used to load sync-recipes.json. */
export function configureSyncOrchestrator(projectRoot: string): void {
  _state.projectRoot = projectRoot
}

export function projectRoot(): string {
  if (!_state.projectRoot) throw new Error("Sync orchestrator not configured — call configureSyncOrchestrator(projectRoot)")
  return _state.projectRoot
}

/** Bracket-quote a `schema.table` identifier → `[schema].[table]`. */
export function qtable(name: string): string {
  return name.split(".").map((p) => `[${p}]`).join(".")
}

/** Convert a JS value to a SQL literal for use in a VALUES clause. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "1" : "0"
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (Buffer.isBuffer(v)) return `0x${v.toString("hex")}`
  return `N'${String(v).replace(/'/g, "''")}'`
}

/**
 * Run async tasks with bounded concurrency. Preserves input order in output.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i]!, i)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * Wraps a `.query()` call with timing + emits a `sync.<kind>.sql` event so
 * per-query duration is observable for the execute path (the preview path
 * already has equivalent telemetry inside diff-engine.ts via runQueryWithRetry).
 */
export async function trackedQuery<T = unknown>(
  req: { query: (sql: string) => Promise<sql.IResult<T>> },
  sqlText: string,
  label: string,
  connection: string,
): Promise<sql.IResult<T>> {
  const t0 = Date.now()
  try {
    const result = await req.query(sqlText)
    emitSyncSqlEvent({
      label,
      connection,
      sql: sqlText,
      durationMs: Date.now() - t0,
      rowCount: result.recordset?.length ?? result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
      attempts: 1,
    })
    return result
  } catch (e) {
    emitSyncSqlEvent({
      label,
      connection,
      sql: sqlText,
      durationMs: Date.now() - t0,
      attempts: 1,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

/** Same as trackedQuery but for `.execute(sproc)` calls. */
export async function trackedExecute(
  req: { execute: (sproc: string) => Promise<sql.IProcedureResult<unknown>> },
  sprocName: string,
  label: string,
  connection: string,
): Promise<sql.IProcedureResult<unknown>> {
  const t0 = Date.now()
  try {
    const result = await req.execute(sprocName)
    emitSyncSqlEvent({
      label,
      connection,
      sql: `EXEC ${sprocName}`,
      durationMs: Date.now() - t0,
      rowCount: result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
      attempts: 1,
    })
    return result
  } catch (e) {
    emitSyncSqlEvent({
      label,
      connection,
      sql: `EXEC ${sprocName}`,
      durationMs: Date.now() - t0,
      attempts: 1,
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}
