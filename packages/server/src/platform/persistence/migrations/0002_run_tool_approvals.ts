import type Database from "better-sqlite3"

export function runRunToolApprovalsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_tool_approvals (
      id            TEXT PRIMARY KEY,
      run_id        TEXT NOT NULL,
      step_id       TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      args_json     TEXT NOT NULL,
      reason        TEXT NOT NULL,
      policy_name   TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed')),
      requested_at  TEXT NOT NULL,
      resolved_at   TEXT,
      resolved_by   TEXT,
      UNIQUE(run_id, step_id)
    );

    CREATE INDEX IF NOT EXISTS idx_run_tool_approvals_run
      ON run_tool_approvals(run_id, status);
    CREATE INDEX IF NOT EXISTS idx_run_tool_approvals_pending
      ON run_tool_approvals(status, requested_at DESC);
  `)
}
