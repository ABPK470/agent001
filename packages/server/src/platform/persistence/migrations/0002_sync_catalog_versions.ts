import type Database from "better-sqlite3"

export function runSyncCatalogVersionsMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_catalog_versions (
      tenant_id     TEXT NOT NULL,
      version       INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      reason        TEXT NOT NULL,
      created_by    TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      PRIMARY KEY (tenant_id, version)
    );

    CREATE INDEX IF NOT EXISTS idx_sync_catalog_versions_tenant_created
      ON sync_catalog_versions (tenant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS sync_catalog_active (
      tenant_id  TEXT PRIMARY KEY,
      version    INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TRIGGER IF NOT EXISTS sync_catalog_versions_no_update
    BEFORE UPDATE ON sync_catalog_versions
    BEGIN
      SELECT RAISE(ABORT, 'sync_catalog_versions is append-only');
    END;

    CREATE TRIGGER IF NOT EXISTS sync_catalog_versions_no_delete
    BEFORE DELETE ON sync_catalog_versions
    BEGIN
      SELECT RAISE(ABORT, 'sync_catalog_versions is append-only');
    END;
  `)
}
