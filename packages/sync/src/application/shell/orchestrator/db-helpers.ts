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
import { getPool } from "../../../adapters/mssql/connection.js"
import { withPoolSlot } from "../../../adapters/mssql/pool-gate.js"
import type { MssqlAccessHost, SyncEventHost, SyncProjectRootHost } from "../../../ports/host.js"
import type { SyncTelemetryContext } from "../events.js"
import { emitSyncSqlEvent } from "../events.js"

/**
 * @deprecated Use {@link resolvePreviewTableConcurrency} — kept for tests that import the constant.
 */
export const PREVIEW_TABLE_CONCURRENCY = Math.max(
  1,
  parseInt(process.env["SYNC_PREVIEW_CONCURRENCY"] ?? "4", 10) || 4
)

/** Configure the project root used to load published sync definitions. */
export function configureSyncOrchestrator(host: SyncProjectRootHost, projectRoot: string): void {
  host.sync.project.dbProjectRoot = projectRoot
}

export function projectRoot(host: SyncProjectRootHost): string {
  const root = host.sync.project.dbProjectRoot
  if (!root)
    throw new Error("Sync orchestrator not configured — call configureSyncOrchestrator(host, projectRoot)")
  return root
}

/** Bracket-quote a `schema.table` identifier → `[schema].[table]`. */
export function qtable(name: string): string {
  return name
    .split(".")
    .map((p) => `[${p}]`)
    .join(".")
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
  fn: (item: T, index: number) => Promise<R>
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
 *
 * When `request` is omitted, acquires a pool gate slot and runs on a fresh
 * pool request. Pass `request` for transaction-bound or pre-parameterized queries.
 */
export async function trackedQuery<T = unknown>(
  host: SyncEventHost & MssqlAccessHost,
  connection: string,
  sqlText: string,
  label: string,
  telemetryContext?: SyncTelemetryContext,
  request?: { query: (sql: string) => Promise<sql.IResult<T>> }
): Promise<sql.IResult<T>> {
  const run = async (req: { query: (sql: string) => Promise<sql.IResult<T>> }): Promise<sql.IResult<T>> => {
    const t0 = Date.now()
    try {
      const result = await req.query(sqlText)
      emitSyncSqlEvent(
        host,
        {
          label,
          connection,
          sql: sqlText,
          durationMs: Date.now() - t0,
          rowCount:
            result.recordset?.length ?? result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
          attempts: 1
        },
        telemetryContext
      )
      return result
    } catch (e) {
      emitSyncSqlEvent(
        host,
        {
          label,
          connection,
          sql: sqlText,
          durationMs: Date.now() - t0,
          attempts: 1,
          error: e instanceof Error ? e.message : String(e)
        },
        telemetryContext
      )
      throw e
    }
  }

  if (request) return run(request)
  return withPoolSlot(host, connection, async () => {
    const { pool } = await getPool(host, connection)
    return run(pool.request())
  })
}

/**
 * Run a parameterized (or custom) query while logging `sqlForLog` for telemetry.
 * Use when the executed statement differs from the human-readable log text.
 */
export async function trackedLoggedQuery<T = unknown>(
  host: SyncEventHost & MssqlAccessHost,
  connection: string,
  label: string,
  sqlForLog: string,
  runQuery: () => Promise<sql.IResult<T>>,
  telemetryContext?: SyncTelemetryContext
): Promise<sql.IResult<T>> {
  const t0 = Date.now()
  try {
    const result = await runQuery()
    emitSyncSqlEvent(
      host,
      {
        label,
        connection,
        sql: sqlForLog,
        durationMs: Date.now() - t0,
        rowCount:
          result.recordset?.length ?? result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
        attempts: 1
      },
      telemetryContext
    )
    return result
  } catch (e) {
    emitSyncSqlEvent(
      host,
      {
        label,
        connection,
        sql: sqlForLog,
        durationMs: Date.now() - t0,
        attempts: 1,
        error: e instanceof Error ? e.message : String(e)
      },
      telemetryContext
    )
    throw e
  }
}

/** Same as trackedQuery but for `.execute(sproc)` calls. */
export async function trackedExecute(
  host: SyncEventHost & MssqlAccessHost,
  connection: string,
  sprocName: string,
  label: string,
  telemetryContext?: SyncTelemetryContext,
  request?: { execute: (sproc: string) => Promise<sql.IProcedureResult<unknown>> }
): Promise<sql.IProcedureResult<unknown>> {
  const run = async (req: {
    execute: (sproc: string) => Promise<sql.IProcedureResult<unknown>>
  }): Promise<sql.IProcedureResult<unknown>> => {
    const t0 = Date.now()
    try {
      const result = await req.execute(sprocName)
      emitSyncSqlEvent(
        host,
        {
          label,
          connection,
          sql: `EXEC ${sprocName}`,
          durationMs: Date.now() - t0,
          rowCount: result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
          attempts: 1
        },
        telemetryContext
      )
      return result
    } catch (e) {
      emitSyncSqlEvent(
        host,
        {
          label,
          connection,
          sql: `EXEC ${sprocName}`,
          durationMs: Date.now() - t0,
          attempts: 1,
          error: e instanceof Error ? e.message : String(e)
        },
        telemetryContext
      )
      throw e
    }
  }

  if (request) return run(request)
  return withPoolSlot(host, connection, async () => {
    const { pool } = await getPool(host, connection)
    return run(pool.request())
  })
}
