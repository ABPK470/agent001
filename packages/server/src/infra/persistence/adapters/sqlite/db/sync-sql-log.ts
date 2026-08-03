/**
 * Persistent full-text SQL trace for sync (and related) MSSQL operations.
 *
 * Contract:
 *   - sync_sql_log holds the full statement (source of truth for complete text).
 *   - event_log JSON for sync.*.sql events carries sql (preview), sqlLength, and sqlLogId.
 *   - sqlLogId is the only runtime link between event_log and sync_sql_log.
 */

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runGet, runInsertId } from "../../../schema/execute.js"
import { platformNow } from "../../../schema/sql-time.js"

export interface SyncSqlLogRow {
  id: number
  plan_id: string | null
  preview_id: string | null
  event_type: string
  scope: string | null
  label: string
  connection: string
  sql_text: string
  duration_ms: number | null
  row_count: number | null
  error: string | null
  created_at: string
}

export interface RecordSyncSqlLogInput {
  planId?: string | null
  previewId?: string | null
  eventType: string
  scope?: string | null
  label: string
  connection: string
  sqlText: string
  durationMs?: number | null
  rowCount?: number | null
  error?: string | null
  createdAt?: string
}

export function recordSyncSqlLog(input: RecordSyncSqlLogInput): number {
  const compiled = getPlatformDb()
    .insertInto("sync_sql_log")
    .values({
      plan_id: input.planId ?? null,
      preview_id: input.previewId ?? null,
      event_type: input.eventType,
      scope: input.scope ?? null,
      label: input.label,
      connection: input.connection,
      sql_text: input.sqlText,
      duration_ms: input.durationMs ?? null,
      row_count: input.rowCount ?? null,
      error: input.error ?? null,
      created_at: input.createdAt != null ? input.createdAt : platformNow(),
    })
    .compile()
  return runInsertId(compiled)
}

export function getSyncSqlLog(id: number): SyncSqlLogRow | undefined {
  const compiled = getPlatformDb()
    .selectFrom("sync_sql_log")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<SyncSqlLogRow>(compiled)
}

export function listSyncSqlLogByPlan(
  planId: string,
  opts?: { limit?: number; offset?: number },
): SyncSqlLogRow[] {
  const limit = Math.min(opts?.limit ?? 500, 2000)
  const offset = opts?.offset ?? 0
  const compiled = getPlatformDb()
    .selectFrom("sync_sql_log")
    .selectAll()
    .where("plan_id", "=", planId)
    .orderBy("id", "asc")
    .limit(limit)
    .offset(offset)
    .compile()
  return runAll<SyncSqlLogRow>(compiled)
}

export function countSyncSqlLogByPlan(planId: string): number {
  const compiled = getPlatformDb()
    .selectFrom("sync_sql_log")
    .select(sql<number>`count(*)`.as("cnt"))
    .where("plan_id", "=", planId)
    .compile()
  const row = runGet<{ cnt: number | bigint }>(compiled)
  return Number(row?.cnt ?? 0)
}

const SQL_EVENT_PREVIEW_MAX_CHARS = 2_000

/** Strip server-only full SQL before SSE / event_log JSON persistence. */
export function stripInternalSqlFields(data: Record<string, unknown>): Record<string, unknown> {
  const { __fullSql: _full, ...rest } = data
  return rest
}

function truncateSqlPreview(fullSql: string): string {
  return fullSql.length > SQL_EVENT_PREVIEW_MAX_CHARS
    ? `${fullSql.slice(0, SQL_EVENT_PREVIEW_MAX_CHARS)}… [+${fullSql.length - SQL_EVENT_PREVIEW_MAX_CHARS} chars]`
    : fullSql
}

function resolveSqlPreview(fullSql: string, existing: unknown): string {
  if (typeof existing === "string" && existing.trim().length > 0) return existing
  return truncateSqlPreview(fullSql)
}

function coercePersistedSqlLogId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value)
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  return null
}

/**
 * Denormalize preview text from sync_sql_log when event_log has sqlLogId but no inline sql.
 * This is a straight FK lookup — not a correlation guess.
 */
export function hydratePersistedSqlEventData(
  eventType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!eventType.endsWith(".sql")) return data

  const existingSql = typeof data["sql"] === "string" ? data["sql"] : ""
  if (existingSql.trim().length > 0) return data

  const sqlLogId = coercePersistedSqlLogId(data["sqlLogId"])
  if (sqlLogId == null) return data

  const row = getSyncSqlLog(sqlLogId)
  if (!row) return data

  return {
    ...data,
    sql: truncateSqlPreview(row.sql_text),
    sqlLength: row.sql_text.length,
  }
}

/**
 * Persist full SQL to sync_sql_log and return event payload with sqlLogId + preview.
 * Called synchronously from the sync event sink before event_log insert.
 */
export function enrichSyncSqlEventData(
  eventType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!eventType.endsWith(".sql")) return data
  const fullSql =
    typeof data["__fullSql"] === "string"
      ? data["__fullSql"]
      : typeof data["sql"] === "string"
        ? data["sql"]
        : null
  const stripped = stripInternalSqlFields(data)
  if (!fullSql) return stripped

  const sqlPreview = resolveSqlPreview(fullSql, stripped["sql"])
  const sqlLength =
    typeof stripped["sqlLength"] === "number" && stripped["sqlLength"] > 0
      ? stripped["sqlLength"]
      : fullSql.length

  const planId =
    typeof data["planId"] === "string"
      ? data["planId"]
      : typeof data["opId"] === "string"
        ? data["opId"]
        : null

  try {
    const sqlLogId = recordSyncSqlLog({
      planId,
      previewId: typeof data["previewId"] === "string" ? data["previewId"] : null,
      eventType,
      scope: typeof data["scope"] === "string" ? data["scope"] : null,
      label: typeof data["label"] === "string" ? data["label"] : "query",
      connection: typeof data["connection"] === "string" ? data["connection"] : "?",
      sqlText: fullSql,
      durationMs: typeof data["durationMs"] === "number" ? data["durationMs"] : null,
      rowCount: typeof data["rowCount"] === "number" ? data["rowCount"] : null,
      error: typeof data["error"] === "string" ? data["error"] : null,
    })

    return {
      ...stripped,
      sql: sqlPreview,
      sqlLength,
      sqlLogId,
    }
  } catch (error) {
    console.warn("[sync-sql-log] recordSyncSqlLog failed; keeping inline SQL preview", error)
    return {
      ...stripped,
      sql: sqlPreview,
      sqlLength,
    }
  }
}
