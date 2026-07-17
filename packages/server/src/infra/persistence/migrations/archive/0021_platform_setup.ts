import type Database from "better-sqlite3"

/** Platform first-run setup — tracks MSSQL/catalog/entity/publish readiness. */
export function runPlatformSetupMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS platform_setup (
      id                    INTEGER PRIMARY KEY CHECK (id = 1),
      completed_at          TEXT,
      mssql_ready_at        TEXT,
      catalog_ready_at      TEXT,
      entities_ready_at     TEXT,
      bundle_published_at   TEXT,
      updated_at            TEXT NOT NULL
    );
  `)

  const existing = db.prepare(`SELECT id FROM platform_setup WHERE id = 1`).get()
  if (!existing) {
    db.prepare(
      `INSERT INTO platform_setup (id, updated_at) VALUES (1, datetime('now'))`,
    ).run()
  }

  const entityCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM entity_defs`).get() as { c: number }
  ).c
  if (entityCount > 0) {
    db.prepare(`
      UPDATE platform_setup
      SET
        completed_at = COALESCE(completed_at, datetime('now')),
        mssql_ready_at = COALESCE(mssql_ready_at, datetime('now')),
        catalog_ready_at = COALESCE(catalog_ready_at, datetime('now')),
        entities_ready_at = COALESCE(entities_ready_at, datetime('now')),
        bundle_published_at = COALESCE(bundle_published_at, datetime('now')),
        updated_at = datetime('now')
      WHERE id = 1
    `).run()
  }
}
