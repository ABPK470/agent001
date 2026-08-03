/**
 * Postgres MigrationRunner — applies platformMultiDialectMigrations
 * through the single platform Kysely handle.
 */

import {
  applyMultiDialectPending,
  type AppliedMigration,
  type MigrationRunner,
} from "@mia/sql-kit"
import { type Kysely, sql } from "kysely"
import { platformMultiDialectMigrations } from "../../../migrations/registry.js"
import type { PlatformDatabase } from "../../../schema/tables.js"

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS _mia_schema_migrations (
  version     INT          NOT NULL PRIMARY KEY,
  name        TEXT         NOT NULL,
  applied_at  TIMESTAMPTZ  NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc')
);
`

export type PostgresMigrationExecutor = {
  query: (sqlText: string) => Promise<{ rows?: unknown[] }>
}

export function kyselyPostgresDdlExecutor(
  db: Kysely<PlatformDatabase>,
): PostgresMigrationExecutor {
  return {
    async query(sqlText) {
      const result = await sql.raw(sqlText).execute(db)
      return { rows: result.rows as unknown[] }
    },
  }
}

async function ensureLedger(executor: PostgresMigrationExecutor): Promise<void> {
  await executor.query(LEDGER_DDL)
}

async function listApplied(executor: PostgresMigrationExecutor): Promise<readonly AppliedMigration[]> {
  await ensureLedger(executor)
  const result = await executor.query(
    `SELECT version, name, applied_at::text AS applied_at
     FROM _mia_schema_migrations
     ORDER BY version ASC`,
  )
  const rows = (result.rows ?? []) as Array<{ version: number; name: string; applied_at: string }>
  return rows.map((r) => ({
    version: Number(r.version),
    name: String(r.name),
    appliedAt: r.applied_at ?? null,
  }))
}

export function createPostgresMigrationRunner(executor: PostgresMigrationExecutor): MigrationRunner {
  return {
    dialect: "postgres",
    async applyPending() {
      await ensureLedger(executor)
      const appliedRows = await listApplied(executor)
      const appliedVersions = new Set(appliedRows.map((r) => r.version))
      await applyMultiDialectPending({
        dialect: "postgres",
        steps: platformMultiDialectMigrations,
        executor,
        applied: {
          has: (version) => appliedVersions.has(version),
          async record(id) {
            const name = id.name.replace(/'/g, "''")
            await executor.query(
              `INSERT INTO _mia_schema_migrations (version, name) VALUES (${id.version}, '${name}')`,
            )
            appliedVersions.add(id.version)
          },
        },
      })
    },
    async list() {
      const applied = await listApplied(executor)
      const byVersion = new Map(applied.map((r) => [r.version, r]))
      return platformMultiDialectMigrations.map((step) => {
        const row = byVersion.get(step.version)
        return {
          version: step.version,
          name: step.name,
          appliedAt: row?.appliedAt ?? null,
        }
      })
    },
  }
}
