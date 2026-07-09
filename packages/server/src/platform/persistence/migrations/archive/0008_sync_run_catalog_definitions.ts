import type Database from "better-sqlite3"

export function runSyncRunCatalogDefinitionsMigration(db: Database.Database): void {
  const phaseCols = db.prepare("PRAGMA table_info(sync_run_phases)").all() as Array<{ name: string }>
  if (!phaseCols.some((col) => col.name === "definition_json")) {
    db.exec(`ALTER TABLE sync_run_phases ADD COLUMN definition_json TEXT NOT NULL DEFAULT '{}'`)
  }

  const kindCols = db.prepare("PRAGMA table_info(sync_run_kinds)").all() as Array<{ name: string }>
  if (!kindCols.some((col) => col.name === "definition_json")) {
    db.exec(`ALTER TABLE sync_run_kinds ADD COLUMN definition_json TEXT NOT NULL DEFAULT '{}'`)
  }
}
