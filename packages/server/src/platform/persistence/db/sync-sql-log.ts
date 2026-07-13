/**
 * Persistent full-text SQL trace for sync (and related) MSSQL operations.
 * Event stream rows carry truncated previews; this table is the complete SOT.
 */

import { getDb } from "../connection.js"

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
  const result = getDb()
    .prepare(
      `
    INSERT INTO sync_sql_log (
      plan_id, preview_id, event_type, scope, label, connection,
      sql_text, duration_ms, row_count, error, created_at
    ) VALUES (
      @plan_id, @preview_id, @event_type, @scope, @label, @connection,
      @sql_text, @duration_ms, @row_count, @error, COALESCE(@created_at, datetime('now'))
    )
  `,
    )
    .run({
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
      created_at: input.createdAt ?? null,
    })
  return Number(result.lastInsertRowid)
}

export function getSyncSqlLog(id: number): SyncSqlLogRow | undefined {
  return getDb().prepare("SELECT * FROM sync_sql_log WHERE id = ?").get(id) as SyncSqlLogRow | undefined
}

export function listSyncSqlLogByPlan(
  planId: string,
  opts?: { limit?: number; offset?: number },
): SyncSqlLogRow[] {
  const limit = Math.min(opts?.limit ?? 500, 2000)
  const offset = opts?.offset ?? 0
  return getDb()
    .prepare(
      `
    SELECT * FROM sync_sql_log
    WHERE plan_id = ?
    ORDER BY id ASC
    LIMIT ? OFFSET ?
  `,
    )
    .all(planId, limit, offset) as SyncSqlLogRow[]
}

export function countSyncSqlLogByPlan(planId: string): number {
  const row = getDb()
    .prepare(
      `
    SELECT COUNT(*) AS cnt FROM sync_sql_log WHERE plan_id = ?
  `,
    )
    .get(planId) as { cnt: number }
  return row.cnt
}

/** Strip server-only full SQL before SSE / event_log JSON persistence. */
export function stripInternalSqlFields(data: Record<string, unknown>): Record<string, unknown> {
  const { __fullSql: _full, ...rest } = data
  return rest
}

export function enrichSyncSqlEventData(
  eventType: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!eventType.endsWith(".sql")) return data
  const fullSql = typeof data["__fullSql"] === "string" ? data["__fullSql"] : typeof data["sql"] === "string" ? data["sql"] : null
  if (!fullSql) return stripInternalSqlFields(data)

  const sqlLogId = recordSyncSqlLog({
    planId: typeof data["planId"] === "string" ? data["planId"] : null,
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
    ...stripInternalSqlFields(data),
    sqlLogId,
  }
}
