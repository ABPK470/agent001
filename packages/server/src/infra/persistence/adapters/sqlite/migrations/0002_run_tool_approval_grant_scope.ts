/**
 * Additive: operator grant scope on run_tool_approvals.
 * Existing rows default to instance (one-shot) — prior behavior.
 */

import type Database from "better-sqlite3"

export function runRunToolApprovalGrantScopeMigration(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(run_tool_approvals)").all() as Array<{ name: string }>
  if (cols.some((c) => c.name === "grant_scope")) return

  // Application + fresh baseline enforce the instance|run domain; ALTER CHECK
  // support varies across SQLite builds used in CI / deploy.
  db.exec(`
    ALTER TABLE run_tool_approvals
      ADD COLUMN grant_scope TEXT NOT NULL DEFAULT 'instance';
  `)
}
