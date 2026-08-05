/**
 * Database migrations runner
 *
 * Terminal schema lives in `0001_baseline.ts` only. Fresh installs (or after
 * deleting mia.db) run baseline once. Append a numbered follow-up (`0002_…`)
 * only when existing installs must upgrade in place without a reset.
 *
 * Pre-squash installs may still have ghost ledger rows for versions 2..N under
 * old names. Those are pruned when not present in {@link MIGRATIONS}, so the
 * next real follow-up can be version 2 on every machine.
 */

import type Database from "better-sqlite3"
import {
  DROP_RETIRED_BROWSER_TABLES_SQL,
  ensureRunToolApprovalGrantScopeColumn,
  runBaselineMigration,
} from "./0001_baseline.js"

export interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "baseline", up: runBaselineMigration },
]

export function runMigrations(db: Database.Database): void {
  ensureMigrationsTable(db)

  const applied = getAppliedVersions(db)
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    migration.up(db)
    recordMigration(db, migration)
  }

  // Idempotent schema truth every boot (same dialect as retired-table drops).
  db.exec(DROP_RETIRED_BROWSER_TABLES_SQL)
  ensureRunToolApprovalGrantScopeColumn(db)

  // Drop ghost ledger rows from the pre-squash incremental chain so the next
  // follow-up can be 0002 without colliding with historical version numbers.
  pruneOrphanMigrationLedger(db)
}

export function listMigrations(db: Database.Database): Array<{
  version: number
  name: string
  applied_at: string | null
}> {
  ensureMigrationsTable(db)
  const applied = new Map(
    (
      db.prepare("SELECT version, name, applied_at FROM schema_migrations").all() as Array<{
        version: number
        name: string
        applied_at: string
      }>
    ).map((r) => [r.version, r])
  )

  return MIGRATIONS.map((m) => ({
    version: m.version,
    name: m.name,
    applied_at: applied.get(m.version)?.applied_at ?? null,
  }))
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL
    );
  `)
}

function getAppliedVersions(db: Database.Database): Set<number> {
  ensureMigrationsTable(db)
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
    version: number
  }>
  return new Set(rows.map((r) => r.version))
}

function recordMigration(db: Database.Database, migration: Migration): void {
  db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, datetime('now'))",
  ).run(migration.version, migration.name)
}

function pruneOrphanMigrationLedger(db: Database.Database): void {
  const keep = new Set(MIGRATIONS.map((m) => m.version))
  const rows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>
  for (const { version } of rows) {
    if (keep.has(version)) continue
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version)
  }
}
