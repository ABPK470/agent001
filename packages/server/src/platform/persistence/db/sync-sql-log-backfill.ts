/**
 * One-time repair for legacy sync SQL events in event_log.
 *
 * Invariant (write path): every sync.*.sql event persisted to event_log carries
 *   { sql: <preview>, sqlLength, sqlLogId } where sqlLogId → sync_sql_log.id.
 *
 * Legacy rows may have sync_sql_log rows but no sqlLogId on the event — this module
 * links them only when a single unambiguous sync_sql_log row matches.
 */

import type Database from "better-sqlite3"

const SQL_EVENT_PREVIEW_MAX_CHARS = 2_000

export interface SyncSqlEventBackfillResult {
  repaired: number
  skippedNoMatch: number
  skippedAmbiguous: number
}

interface EventLogRow {
  id: number
  type: string
  data: string
  created_at: string
}

interface SqlLogRow {
  id: number
  plan_id: string | null
  preview_id: string | null
  event_type: string
  label: string
  connection: string
  sql_text: string
  duration_ms: number | null
  row_count: number | null
}

function truncateSqlPreview(fullSql: string): string {
  return fullSql.length > SQL_EVENT_PREVIEW_MAX_CHARS
    ? `${fullSql.slice(0, SQL_EVENT_PREVIEW_MAX_CHARS)}… [+${fullSql.length - SQL_EVENT_PREVIEW_MAX_CHARS} chars]`
    : fullSql
}

function parseEventData(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function eventScopeIds(data: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const key of ["planId", "opId", "previewId"] as const) {
    const value = data[key]
    if (typeof value === "string" && value.length > 0) ids.push(value)
  }
  return ids
}

function sqlLogMatchesScope(row: SqlLogRow, scopeIds: readonly string[]): boolean {
  if (scopeIds.length === 0) return row.plan_id == null && row.preview_id == null
  return (
    (row.plan_id != null && scopeIds.includes(row.plan_id)) ||
    (row.preview_id != null && scopeIds.includes(row.preview_id))
  )
}

function eventNeedsRepair(data: Record<string, unknown>): boolean {
  const sql = typeof data["sql"] === "string" ? data["sql"] : ""
  if (sql.trim().length > 0) {
    const sqlLogId = data["sqlLogId"]
    if (typeof sqlLogId === "number" && sqlLogId > 0) return false
    if (typeof sqlLogId === "string" && /^\d+$/.test(sqlLogId.trim())) return false
  }
  return true
}

function listSqlLogCandidates(
  db: Database.Database,
  eventType: string,
  data: Record<string, unknown>,
): SqlLogRow[] {
  const label = typeof data["label"] === "string" ? data["label"] : null
  const connection = typeof data["connection"] === "string" ? data["connection"] : null
  if (!label || !connection) return []

  const durationMs = typeof data["durationMs"] === "number" ? data["durationMs"] : null
  const rowCount = typeof data["rowCount"] === "number" ? data["rowCount"] : null
  const scopeIds = eventScopeIds(data)

  const candidates = db
    .prepare(
      `
    SELECT id, plan_id, preview_id, event_type, label, connection, sql_text, duration_ms, row_count
    FROM sync_sql_log
    WHERE event_type = ?
      AND label = ?
      AND connection = ?
      AND (duration_ms = ? OR (duration_ms IS NULL AND ? IS NULL))
      AND (row_count = ? OR (row_count IS NULL AND ? IS NULL))
  `,
    )
    .all(eventType, label, connection, durationMs, durationMs, rowCount, rowCount) as SqlLogRow[]

  return candidates.filter((row) => sqlLogMatchesScope(row, scopeIds))
}

export function backfillSyncSqlEventLogLinks(db: Database.Database): SyncSqlEventBackfillResult {
  const result: SyncSqlEventBackfillResult = {
    repaired: 0,
    skippedNoMatch: 0,
    skippedAmbiguous: 0,
  }

  const events = db
    .prepare(
      `
    SELECT id, type, data, created_at
    FROM event_log
    WHERE type LIKE 'sync.%.sql'
    ORDER BY id ASC
  `,
    )
    .all() as EventLogRow[]

  const update = db.prepare("UPDATE event_log SET data = ? WHERE id = ?")

  for (const event of events) {
    const data = parseEventData(event.data)
    if (!data || !eventNeedsRepair(data)) continue

    const scoped = listSqlLogCandidates(db, event.type, data)

    if (scoped.length === 0) {
      result.skippedNoMatch++
      continue
    }
    if (scoped.length > 1) {
      result.skippedAmbiguous++
      continue
    }

    const match = scoped[0]!
    const repaired = {
      ...data,
      sql: truncateSqlPreview(match.sql_text),
      sqlLength: match.sql_text.length,
      sqlLogId: match.id,
    }
    update.run(JSON.stringify(repaired), event.id)
    result.repaired++
  }

  return result
}
