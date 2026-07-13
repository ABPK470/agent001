import type Database from "better-sqlite3"

/** Full-text SQL trace — source of truth for complete statements (events carry previews). */
export function runSyncSqlLogMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_sql_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id      TEXT,
      preview_id   TEXT,
      event_type   TEXT NOT NULL,
      scope        TEXT,
      label        TEXT NOT NULL,
      connection   TEXT NOT NULL,
      sql_text     TEXT NOT NULL,
      duration_ms  INTEGER,
      row_count    INTEGER,
      error        TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_sql_log_plan    ON sync_sql_log(plan_id, id);
    CREATE INDEX IF NOT EXISTS idx_sync_sql_log_preview ON sync_sql_log(preview_id, id);
    CREATE INDEX IF NOT EXISTS idx_sync_sql_log_time    ON sync_sql_log(created_at DESC);
  `)
}
