/**
 * Migration 5 — evaluation dataset golden steps captured from trace inspector.
 */

import type Database from "better-sqlite3"

export function runEvalDatasetMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_dataset_entries (
      id          TEXT PRIMARY KEY,
      thread_id   TEXT,
      run_id      TEXT NOT NULL,
      scope_id    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      call_index  INTEGER,
      label       TEXT,
      input_json  TEXT NOT NULL,
      output_json TEXT,
      metadata_json TEXT,
      created_by  TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_dataset_run ON eval_dataset_entries(run_id);
    CREATE INDEX IF NOT EXISTS idx_eval_dataset_thread ON eval_dataset_entries(thread_id);
    CREATE INDEX IF NOT EXISTS idx_eval_dataset_created ON eval_dataset_entries(created_at DESC);
  `)
}
