/**
 * SQLite {@link MigrationRunner} — wraps the existing numbered migrations.
 *
 * Peer mssql DDL lives in `persistence/migrations/registry.ts` and is applied
 * by `adapters/mssql/migrations/runner.ts`. SQLite keeps this numbered path.
 */

import type { MigrationRunner } from "@mia/sql-kit"
import type Database from "better-sqlite3"
import { listMigrations, runMigrations } from "./index.js"

export function createSqliteMigrationRunner(db: Database.Database): MigrationRunner {
  return {
    dialect: "sqlite",
    applyPending() {
      runMigrations(db)
    },
    list() {
      return listMigrations(db).map((row) => ({
        version: row.version,
        name: row.name,
        appliedAt: row.applied_at,
      }))
    },
  }
}
