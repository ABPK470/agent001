/**
 * Drop threads.kind — all threads are equal conversation workspaces.
 * Legacy workspace rows become normal threads (visible in sidebar).
 */

import type Database from "better-sqlite3"

export function runRemoveThreadKindMigration(db: Database.Database): void {
  const columns = db.pragma("table_info(threads)") as Array<{ name: string }>
  if (!columns.some((c) => c.name === "kind")) return

  db.exec("DROP INDEX IF EXISTS idx_threads_workspace_per_user")
  db.exec("DROP INDEX IF EXISTS idx_threads_platform_per_user")
  db.exec(`ALTER TABLE threads DROP COLUMN kind`)
}
