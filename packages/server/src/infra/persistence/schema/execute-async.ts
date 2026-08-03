/**
 * Dialect-aware async execute — SQLite sync wrappers; server RDBMS via Kysely
 * when {@link bindPlatformDb} has bound mssql/postgres.
 */

import type { CompiledQuery as KyselyCompiledQuery } from "kysely"
import {
  runAll,
  runChanges,
  runExec,
  runGet,
  runInsertId,
  type CompiledQuery,
} from "./execute.js"
import { getPlatformDb, getPlatformDbKind } from "./kysely.js"

function asKyselyCompiled(compiled: CompiledQuery): KyselyCompiledQuery {
  return compiled as KyselyCompiledQuery
}

export async function runAllAsync<T>(compiled: CompiledQuery): Promise<T[]> {
  if (getPlatformDbKind() === "sqlite") return runAll<T>(compiled)
  const result = await getPlatformDb().executeQuery(asKyselyCompiled(compiled))
  return result.rows as T[]
}

export async function runGetAsync<T>(compiled: CompiledQuery): Promise<T | undefined> {
  if (getPlatformDbKind() === "sqlite") return runGet<T>(compiled)
  const result = await getPlatformDb().executeQuery(asKyselyCompiled(compiled))
  return (result.rows[0] as T | undefined) ?? undefined
}

export async function runExecAsync(compiled: CompiledQuery): Promise<void> {
  if (getPlatformDbKind() === "sqlite") {
    runExec(compiled)
    return
  }
  await getPlatformDb().executeQuery(asKyselyCompiled(compiled))
}

export async function runChangesAsync(compiled: CompiledQuery): Promise<number> {
  if (getPlatformDbKind() === "sqlite") return runChanges(compiled)
  const result = await getPlatformDb().executeQuery(asKyselyCompiled(compiled))
  return Number(result.numAffectedRows ?? 0)
}

/**
 * Inject `OUTPUT INSERTED.id` into a compiled INSERT for MSSQL identity return.
 * Expects Kysely-shaped `insert into … (…) values …`.
 */
export function injectMssqlOutputInsertedId(sqlText: string): string {
  const match = /^(\s*insert\s+into\s+[\w."[\]]+\s*\([^)]*\))\s*(values\b)/i.exec(sqlText)
  if (!match) {
    throw new Error(
      `runInsertIdAsync: cannot inject OUTPUT INSERTED.id into SQL: ${sqlText.slice(0, 160)}`,
    )
  }
  return `${match[1]} OUTPUT INSERTED.id ${match[2]}${sqlText.slice(match[0].length)}`
}

/**
 * Inject `RETURNING id` into a compiled INSERT for Postgres identity return.
 * Expects Kysely-shaped `insert into … (…) values …`.
 */
export function injectPostgresReturningId(sqlText: string): string {
  const trimmed = sqlText.replace(/;\s*$/, "")
  const match = /^(\s*insert\s+into\s+[\w."[\]]+\s*\([^)]*\))\s*(values\b[\s\S]+)$/i.exec(trimmed)
  if (!match) {
    throw new Error(
      `runInsertIdAsync: cannot inject RETURNING id into SQL: ${sqlText.slice(0, 160)}`,
    )
  }
  if (/returning\b/i.test(match[2]!)) {
    throw new Error("runInsertIdAsync: INSERT already has RETURNING")
  }
  return `${match[1]} ${match[2]} returning id`
}

/**
 * Insert and return the generated integer id (single-row only).
 * SQLite: `lastInsertRowid`. MSSQL: `OUTPUT INSERTED.id`. Postgres: `RETURNING id`.
 *
 * Multi-row inserts must not use this helper — use Kysely `.returning('id')` instead.
 */
export async function runInsertIdAsync(compiled: CompiledQuery): Promise<number> {
  const kind = getPlatformDbKind()
  if (kind === "sqlite") return runInsertId(compiled)

  if (kind === "postgres") {
    const sqlText = injectPostgresReturningId(compiled.sql)
    const result = await getPlatformDb().executeQuery(
      asKyselyCompiled({ sql: sqlText, parameters: compiled.parameters }),
    )
    if (result.rows.length === 0) {
      throw new Error("runInsertIdAsync: Postgres INSERT returned no id")
    }
    if (result.rows.length > 1) {
      throw new Error(
        "runInsertIdAsync: Postgres INSERT returned multiple ids — single-row inserts only",
      )
    }
    const row = result.rows[0] as { id?: number | string | bigint }
    if (row.id === undefined || row.id === null) {
      throw new Error("runInsertIdAsync: Postgres INSERT returned no id")
    }
    return Number(row.id)
  }

  const sqlText = injectMssqlOutputInsertedId(compiled.sql)
  const result = await getPlatformDb().executeQuery(
    asKyselyCompiled({ sql: sqlText, parameters: compiled.parameters }),
  )
  if (result.rows.length > 1) {
    throw new Error(
      "runInsertIdAsync: MSSQL INSERT returned multiple ids — single-row inserts only",
    )
  }
  const row = result.rows[0] as { id?: number | string | bigint } | undefined
  const id = row?.id
  if (id === undefined || id === null) {
    throw new Error("runInsertIdAsync: MSSQL INSERT returned no id")
  }
  return Number(id)
}
