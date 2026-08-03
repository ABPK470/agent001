/**
 * Dialect-aware async execute — SQLite sync wrappers today; MSSQL via Kysely
 * when {@link bindPlatformDb} has bound an mssql handle.
 *
 * Product repos still call sync {@link ./execute.js}; migrate call sites to
 * these helpers as the async port cutover proceeds.
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
 * Insert and return the generated integer id.
 * SQLite: `lastInsertRowid`. MSSQL: `OUTPUT INSERTED.id` injected into the compiled INSERT.
 */
export async function runInsertIdAsync(compiled: CompiledQuery): Promise<number> {
  if (getPlatformDbKind() === "sqlite") return runInsertId(compiled)
  const sqlText = injectMssqlOutputInsertedId(compiled.sql)
  const result = await getPlatformDb().executeQuery(
    asKyselyCompiled({ sql: sqlText, parameters: compiled.parameters }),
  )
  const row = result.rows[0] as { id?: number | string | bigint } | undefined
  const id = row?.id
  if (id === undefined || id === null) {
    throw new Error("runInsertIdAsync: MSSQL INSERT returned no id")
  }
  return Number(id)
}
