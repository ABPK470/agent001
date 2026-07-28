/**
 * Database migrations runner
 *
 * Terminal schema lives in `0001_baseline.ts` only. Fresh installs (or after
 * deleting mia.db) run baseline once.
 */

import type Database from "better-sqlite3"
import { runBaselineMigration } from "./0001_baseline.js"
import { runSyncToolApprovalsMigration } from "./0002_sync_tool_approvals.js"
import { runDropAgentConfigsMigration } from "./0003_drop_agent_configs.js"

export interface Migration {
  version: number
  name: string
  up: (db: Database.Database) => void
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "baseline", up: runBaselineMigration },
  { version: 2, name: "sync_tool_approvals", up: runSyncToolApprovalsMigration },
  { version: 3, name: "drop_agent_configs", up: runDropAgentConfigsMigration },
]

export function runMigrations(db: Database.Database): void {
  ensureMigrationsTable(db)

  const applied = getAppliedVersions(db)
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    migration.up(db)
    recordMigration(db, migration)
  }
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
