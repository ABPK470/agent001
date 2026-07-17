import type Database from "better-sqlite3"

export function runSyncRunCatalogMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_run_phases (
      tenant_id   TEXT NOT NULL,
      id          TEXT NOT NULL,
      label       TEXT NOT NULL,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      built_in    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, id)
    );

    CREATE TABLE IF NOT EXISTS sync_run_kinds (
      tenant_id   TEXT NOT NULL,
      id          TEXT NOT NULL,
      label       TEXT NOT NULL,
      built_in    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, id)
    );

    CREATE TABLE IF NOT EXISTS sync_run_presets (
      tenant_id     TEXT NOT NULL,
      id            TEXT NOT NULL,
      label         TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      steps_json    TEXT NOT NULL DEFAULT '[]',
      built_in      INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL,
      updated_by    TEXT,
      PRIMARY KEY (tenant_id, id)
    );
  `)
}
