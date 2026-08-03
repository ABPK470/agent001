/**
 * Compile Kysely → execute on the process SQLite driver (sync cutover).
 */

import { getDb } from "../adapters/sqlite/connection.js"

export function runAll<T>(compiled: { sql: string; parameters: readonly unknown[] }): T[] {
  return getDb().prepare(compiled.sql).all(...compiled.parameters) as T[]
}

export function runGet<T>(compiled: { sql: string; parameters: readonly unknown[] }): T | undefined {
  return getDb().prepare(compiled.sql).get(...compiled.parameters) as T | undefined
}

export function runExec(compiled: { sql: string; parameters: readonly unknown[] }): void {
  getDb().prepare(compiled.sql).run(...compiled.parameters)
}

/** Like {@link runExec}, but returns `changes` (DELETE/UPDATE row count). */
export function runChanges(compiled: { sql: string; parameters: readonly unknown[] }): number {
  return getDb().prepare(compiled.sql).run(...compiled.parameters).changes
}
