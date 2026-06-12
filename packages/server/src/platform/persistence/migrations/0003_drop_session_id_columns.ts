import type Database from "better-sqlite3"

/**
 * Drop cookie-session_id denormalization from agent/memory tables.
 * Tenancy and live feeds use upn; conversation continuity uses thread_id.
 * The auth `sessions` table (login cookies) is unchanged.
 */
export function runDropSessionIdColumnsMigration(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_runs_session`)
  db.exec(`DROP INDEX IF EXISTS idx_tool_results_session`)
  db.exec(`DROP INDEX IF EXISTS idx_me_session`)
  db.exec(`DROP INDEX IF EXISTS idx_proc_session`)
  db.exec(`DROP INDEX IF EXISTS idx_notifications_session`)
  db.exec(`DROP INDEX IF EXISTS idx_attachments_session`)

  const drops: Array<{ table: string; column: string }> = [
    { table: "runs", column: "session_id" },
    { table: "tool_results", column: "session_id" },
    { table: "memory_entries", column: "session_id" },
    { table: "procedural_memories", column: "session_id" },
    { table: "notifications", column: "session_id" },
    { table: "attachments", column: "session_id" }
  ]

  for (const { table, column } of drops) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    }
  }
}
