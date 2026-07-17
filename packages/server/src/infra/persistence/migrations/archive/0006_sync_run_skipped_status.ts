/**
 * Allow `skipped` in sync_runs.status (audit gate returned stop — sync not required).
 */

import type Database from "better-sqlite3"

export function runSyncRunSkippedStatusMigration(db: Database.Database): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sync_runs'`).get() as
    | { sql: string }
    | undefined
  if (!row?.sql || row.sql.includes("'skipped'")) return

  db.exec(`
    CREATE TABLE sync_runs_new (
      plan_id              TEXT PRIMARY KEY,
      entity_type          TEXT NOT NULL,
      entity_id            TEXT NOT NULL,
      entity_display_name  TEXT,
      source               TEXT NOT NULL,
      target               TEXT NOT NULL,
      actor_upn            TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      preview_inserts      INTEGER NOT NULL DEFAULT 0,
      preview_updates      INTEGER NOT NULL DEFAULT 0,
      preview_deletes      INTEGER NOT NULL DEFAULT 0,
      executed_inserts     INTEGER,
      executed_updates     INTEGER,
      executed_deletes     INTEGER,
      preview_totals_json  TEXT NOT NULL,
      execute_totals_json  TEXT,
      plan_json            TEXT,
      status               TEXT NOT NULL
        CHECK (status IN ('started','preview','success','failed','skipped')),
      error                TEXT,
      drift_detected_pct   REAL,
      started_at           TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at          TEXT,
      duration_ms          INTEGER
    );

    INSERT INTO sync_runs_new SELECT * FROM sync_runs;

    DROP TABLE sync_runs;
    ALTER TABLE sync_runs_new RENAME TO sync_runs;

    CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_target  ON sync_runs(target);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_actor   ON sync_runs(actor_upn);
  `)
}
