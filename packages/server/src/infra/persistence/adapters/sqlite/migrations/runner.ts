/**
 * SQLite {@link MigrationRunner} — wraps the existing numbered migrations.
 *
 * Multi-dialect peers (mssql/postgres) will implement the same contract with
 * their own DDL bodies; this adapter keeps today’s better-sqlite3 path green.
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
