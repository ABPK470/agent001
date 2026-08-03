/**
 * MSSQL {@link MigrationRunner} — applies {@link platformMultiDialectMigrations}
 * through the single platform Kysely handle (tedious/tarn). No mssql.ConnectionPool.
 *
 * Ledger table: `dbo._mia_schema_migrations` (platform-owned; never warehouse).
 */

import {
  applyMultiDialectPending,
  type AppliedMigration,
  type MigrationRunner,
} from "@mia/sql-kit"
import { type Kysely, sql } from "kysely"
import {
  platformMultiDialectMigrations,
  type MssqlMigrationExecutor,
} from "../../../migrations/registry.js"
import type { PlatformDatabase } from "../../../schema/tables.js"

const LEDGER_DDL = `
IF OBJECT_ID(N'dbo._mia_schema_migrations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo._mia_schema_migrations (
    version     INT            NOT NULL CONSTRAINT PK_mia_schema_migrations PRIMARY KEY,
    name        NVARCHAR(256)  NOT NULL,
    applied_at  DATETIME2      NOT NULL CONSTRAINT DF_mia_schema_migrations_applied_at DEFAULT (SYSUTCDATETIME())
  );
END;
`

export type MssqlQueryExecutor = MssqlMigrationExecutor & {
  query: (sqlText: string) => Promise<{ recordset?: unknown }>
}

/**
 * DDL executor over the platform Kysely instance (same tarn pool as DML/tx).
 * Registry steps and ledger writes all go through this.
 */
export function kyselyPlatformDdlExecutor(
  db: Kysely<PlatformDatabase>,
): MssqlQueryExecutor {
  return {
    async query(sqlText) {
      const result = await sql.raw(sqlText).execute(db)
      return { recordset: result.rows }
    },
  }
}

async function ensureLedger(executor: MssqlQueryExecutor): Promise<void> {
  await executor.query(LEDGER_DDL)
}

async function listApplied(executor: MssqlQueryExecutor): Promise<readonly AppliedMigration[]> {
  await ensureLedger(executor)
  const result = (await executor.query(
    `SELECT version, name, CONVERT(varchar(33), applied_at, 127) AS applied_at
     FROM dbo._mia_schema_migrations
     ORDER BY version ASC`,
  )) as { recordset?: Array<{ version: number; name: string; applied_at: string }> }
  const rows = result.recordset ?? []
  return rows.map((r) => ({
    version: Number(r.version),
    name: String(r.name),
    appliedAt: r.applied_at ?? null,
  }))
}

export function createMssqlMigrationRunner(executor: MssqlQueryExecutor): MigrationRunner {
  return {
    dialect: "mssql",
    async applyPending() {
      await ensureLedger(executor)
      const appliedRows = await listApplied(executor)
      const appliedVersions = new Set(appliedRows.map((r) => r.version))
      await applyMultiDialectPending({
        dialect: "mssql",
        steps: platformMultiDialectMigrations,
        executor,
        applied: {
          has: (version) => appliedVersions.has(version),
          async record(id) {
            await executor.query(
              `INSERT INTO dbo._mia_schema_migrations (version, name)
               VALUES (${id.version}, N'${id.name.replace(/'/g, "''")}')`,
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
