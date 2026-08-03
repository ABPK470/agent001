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
 * Insert id — SQLite `lastInsertRowid` only.
 * MSSQL callers should use `OUTPUT INSERTED.id` in the query body instead.
 */
export async function runInsertIdAsync(compiled: CompiledQuery): Promise<number> {
  if (getPlatformDbKind() === "sqlite") return runInsertId(compiled)
  throw new Error(
    "runInsertIdAsync is sqlite-only — use OUTPUT INSERTED.* on mssql inserts",
  )
}
