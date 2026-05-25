/**
 * Low-level SQL helpers for the diff engine.
 *
 * Identifier quoting, transient-error detection, retrying query runner
 * (with `sync.<kind>.sql` telemetry), per-type culture-invariant CONVERT
 * expressions for HASHBYTES, and SQL literal coercion.
 *
 * @module
 */

import type sql from "mssql"
import type { AgentHost } from "../../host/index.js"
import { emitSyncSqlEvent, type SyncSqlTraceContext } from "../sync-events.js"
import type { HashColumn, PkHashRow } from "./types.js"

/** Bracket-quote a `schema.table` identifier → `[schema].[table]`. */
export function qtable(name: string): string {
  return name.split(".").map((p) => `[${p}]`).join(".")
}

/**
 * Detect transient mssql errors that are safe to retry. The pool's TDS
 * connections can be killed by server-side timeout, network blip, or
 * `requestTimeout` firing, leaving the next request on that conn with
 * `ConnectionError: Connection is closed.` Retrying gets a fresh conn.
 */
export function isTransientMssqlError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  const code = (e as { code?: string }).code ?? ""
  if (code === "ETIMEOUT" || code === "ECONNRESET" || code === "ECONNCLOSED" || code === "ESOCKET") return true
  return (
    msg.includes("connection is closed") ||
    msg.includes("connection lost") ||
    msg.includes("connection reset") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout: request failed to complete") ||
    msg.includes("the connection is closed")
  )
}

/**
 * Run a query with bounded retries on transient connection failures.
 * Backoff: 100ms, 400ms (jittered).
 */
export async function runQueryWithRetry<T = unknown>(
  host: AgentHost,
  pool: sql.ConnectionPool,
  query: string,
  label: string,
  syncTrace: SyncSqlTraceContext | null = null,
  maxRetries = 2,
): Promise<sql.IResult<T>> {
  const t0 = Date.now()
  const connection = (pool as unknown as { config?: { database?: string } }).config?.database ?? "<unknown>"
  let lastErr: unknown
  let attempts = 0
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1
    try {
      const result = await pool.request().query<T>(query)
      emitSyncSqlEvent(host, {
        label, connection, sql: query,
        durationMs: Date.now() - t0,
        rowCount: result.recordset?.length ?? result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
        attempts,
      }, syncTrace)
      return result
    } catch (e) {
      lastErr = e
      if (attempt === maxRetries || !isTransientMssqlError(e)) {
        emitSyncSqlEvent(host, {
          label, connection, sql: query,
          durationMs: Date.now() - t0,
          attempts,
          error: e instanceof Error ? e.message : String(e),
        }, syncTrace)
        throw e
      }
      const delay = 100 * Math.pow(4, attempt) + Math.floor(Math.random() * 50)
      console.warn(`[sync.diff] transient error on ${label} (attempt ${attempt + 1}/${maxRetries + 1}): ${e instanceof Error ? e.message : String(e)} — retrying in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

/**
 * Build a culture-invariant SQL expression that converts `[col]` to NVARCHAR
 * for hashing. The default `CAST(x AS NVARCHAR(MAX))` is NOT safe — its output
 * for datetime/float/money varies with session LANGUAGE/DATEFORMAT, which
 * differs between pooled TDS connections.
 */
export function hashExpr(col: HashColumn): string {
  const c = `[${col.name}]`
  switch (col.systemType) {
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      // Style 126/127 = ISO-8601, culture-invariant.
      return `CONVERT(NVARCHAR(33), ${c}, 126)`
    case "date":
      return `CONVERT(NVARCHAR(10), ${c}, 23)`
    case "time":
      return `CONVERT(NVARCHAR(16), ${c}, 114)`
    case "float":
    case "real":
      // Style 2 = full 17-digit scientific, invariant.
      return `CONVERT(NVARCHAR(64), ${c}, 2)`
    case "money":
    case "smallmoney":
      // Style 2 = 4 decimal places, no commas.
      return `CONVERT(NVARCHAR(32), ${c}, 2)`
    case "binary":
    case "varbinary":
    case "image":
    case "timestamp":
    case "rowversion":
      // Style 1 = '0x...' hex.
      return `CONVERT(NVARCHAR(MAX), ${c}, 1)`
    case "uniqueidentifier":
      return `CONVERT(NVARCHAR(36), ${c})`
    case "xml":
    case "hierarchyid":
    case "geography":
    case "geometry":
    case "sql_variant":
      return `CONVERT(NVARCHAR(MAX), CONVERT(VARBINARY(MAX), ${c}), 1)`
    default:
      return `CAST(${c} AS NVARCHAR(MAX))`
  }
}

/** SQL literal for use in IN / equality clauses. */
export function quoteValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "1" : "0"
  return `N'${String(v).replace(/'/g, "''")}'`
}

/** Same as quoteValue but with single quotes for non-numeric/bool — used in human-facing summaries. */
export function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return `'${String(v)}'`
}

/**
 * Build a WHERE clause that matches all rows in `rows` by their PK values.
 * Single-column PK → `[pk] IN (v1, v2, ...)` (efficient index seek).
 * Composite PK → `([pk1] = v1 AND [pk2] = v2) OR (...)` (row-constructor).
 */
export function buildBatchWhere(rows: PkHashRow[], pkColumns: string[]): string {
  if (pkColumns.length === 1) {
    const col = pkColumns[0]!
    const values = rows.map((r) => quoteValue(r.pkValues[col])).join(", ")
    return `[${col}] IN (${values})`
  }
  // Composite PK — OR of AND-ed equality predicates.
  const clauses = rows.map((r) =>
    "(" + pkColumns.map((c) => `[${c}] = ${quoteValue(r.pkValues[c])}`).join(" AND ") + ")"
  )
  return clauses.join(" OR ")
}
