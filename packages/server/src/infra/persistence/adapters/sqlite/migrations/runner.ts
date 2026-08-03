/**
 * SQLite {@link MigrationRunner} — wraps the existing numbered migrations.
 *
 * Milestone 4 will re-express steps as `MultiDialectMigrationStep` (see
 * `@mia/sql-kit` `upForDialect`) so mssql/postgres supply peer DDL bodies.
 * Today this adapter keeps the better-sqlite3 numbered path green.
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
