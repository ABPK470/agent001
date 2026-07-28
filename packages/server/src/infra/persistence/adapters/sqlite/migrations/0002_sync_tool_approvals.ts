/**
 * Migration 2 — sync_tool_approvals for HTTP Sync policy grants.
 * Existing installs that already applied baseline need this version.
 */

import type Database from "better-sqlite3"

export function runSyncToolApprovalsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_tool_approvals (
      id            TEXT PRIMARY KEY,
      actor_upn     TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      args_json     TEXT NOT NULL,
      args_key      TEXT NOT NULL,
      reason        TEXT NOT NULL,
      policy_name   TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed')),
      requested_at  TEXT NOT NULL,
      resolved_at   TEXT,
      resolved_by   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_tool_approvals_actor
      ON sync_tool_approvals(actor_upn, tool_name, status);
    CREATE INDEX IF NOT EXISTS idx_sync_tool_approvals_pending
      ON sync_tool_approvals(status, requested_at DESC);
  `)
}
