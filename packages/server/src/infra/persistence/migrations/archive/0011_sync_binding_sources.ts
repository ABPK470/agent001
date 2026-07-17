import type Database from "better-sqlite3"

export function runSyncBindingSourcesMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_run_binding_sources (
      tenant_id        TEXT NOT NULL,
      id               TEXT NOT NULL,
      label            TEXT NOT NULL,
      built_in         INTEGER NOT NULL DEFAULT 0,
      definition_json  TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (tenant_id, id)
    );
  `)
}
