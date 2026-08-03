/**
 * Compile Kysely → execute on the process SQLite driver (sync cutover).
 *
 * For multi-dialect / async paths use {@link ./execute-async.js}. These
 * sync helpers throw if the bound platform dialect is not sqlite.
 */

import { getDb } from "../adapters/sqlite/connection.js"
import { getPlatformDbKind } from "./kysely.js"

export type CompiledQuery = {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

function assertSqliteSync(): void {
  const kind = getPlatformDbKind()
  if (kind !== "sqlite") {
    throw new Error(
      `Sync schema/execute requires sqlite (bound dialect is ${kind}). ` +
        `Use run*Async from schema/execute-async.js.`,
    )
  }
}

export function runAll<T>(compiled: CompiledQuery): T[] {
  assertSqliteSync()
  return getDb().prepare(compiled.sql).all(...compiled.parameters) as T[]
}

export function runGet<T>(compiled: CompiledQuery): T | undefined {
  assertSqliteSync()
  return getDb().prepare(compiled.sql).get(...compiled.parameters) as T | undefined
}

export function runExec(compiled: CompiledQuery): void {
  assertSqliteSync()
  getDb().prepare(compiled.sql).run(...compiled.parameters)
}

/** Like {@link runExec}, but returns `changes` (DELETE/UPDATE row count). */
export function runChanges(compiled: CompiledQuery): number {
  assertSqliteSync()
  return getDb().prepare(compiled.sql).run(...compiled.parameters).changes
}

/** Like {@link runExec}, but returns SQLite `lastInsertRowid`. */
export function runInsertId(compiled: CompiledQuery): number {
  assertSqliteSync()
  return Number(getDb().prepare(compiled.sql).run(...compiled.parameters).lastInsertRowid)
}
