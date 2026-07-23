/**
 * Migration 3 — erase multi-agent CRUD from the schema.
 *
 * Named agent definitions (create/edit/delete a custom system prompt +
 * tool whitelist) never shipped past internal use; every run now always
 * uses the file-managed default system prompt (`packages/agent/prompts/
 * default-system.md`). Drops `runs.agent_id` (SQLite 3.35+ supports
 * ALTER TABLE DROP COLUMN directly — the column carries no index) and the
 * now-orphaned `agent_configs` table. Existing installs need this; fresh
 * installs just run it as a no-op immediately after baseline creates both.
 */

import type Database from "better-sqlite3"

export function runDropAgentConfigsMigration(db: Database.Database): void {
  const runsColumns = db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>
  if (runsColumns.some((c) => c.name === "agent_id")) {
    db.exec("ALTER TABLE runs DROP COLUMN agent_id")
  }
  db.exec("DROP TABLE IF EXISTS agent_configs")
}
