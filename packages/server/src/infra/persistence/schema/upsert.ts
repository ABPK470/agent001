/**
 * Dialect-portable single-row upsert.
 *
 * SQLite/Postgres `ON CONFLICT` is not available on MSSQL. This helper
 * does select → update | insert on the bound platform dialect so product
 * repos stay one code path. Call inside a transaction when concurrent
 * writers on the same key are possible.
 */

import { sql } from "kysely"
import type { CompiledQuery } from "./execute.js"
import { runExec, runGet } from "./execute.js"
import { getPlatformDb } from "./kysely.js"
import type { PlatformDatabase } from "./tables.js"

type TableName = keyof PlatformDatabase & string

export type UpsertArgs = {
  table: TableName
  /** Primary / unique key columns → values. */
  keys: Record<string, unknown>
  /** Full row for INSERT (must include key columns). */
  insert: object
  /** Columns to SET on conflict (must not need to restate keys). */
  update: object
}

function existsCompiled(table: TableName, keys: Record<string, unknown>): CompiledQuery {
  let q = getPlatformDb().selectFrom(table as never).select(sql<number>`1`.as("ok"))
  for (const [col, value] of Object.entries(keys)) {
    q = q.where(col as never, "=", value as never)
  }
  return q.compile()
}

function updateCompiled(
  table: TableName,
  keys: Record<string, unknown>,
  update: object,
): CompiledQuery {
  let q = getPlatformDb().updateTable(table as never).set(update as never)
  for (const [col, value] of Object.entries(keys)) {
    q = q.where(col as never, "=", value as never)
  }
  return q.compile()
}

function insertCompiled(table: TableName, insert: object): CompiledQuery {
  return getPlatformDb()
    .insertInto(table as never)
    .values(insert as never)
    .compile()
}

/** Sync upsert (sqlite execute path today). */
export function upsertRow(args: UpsertArgs): void {
  const hit = runGet<{ ok: number }>(existsCompiled(args.table, args.keys))
  if (hit) {
    runExec(updateCompiled(args.table, args.keys, args.update))
    return
  }
  runExec(insertCompiled(args.table, args.insert))
}

/** Insert-or-ignore: skip when the key already exists. Returns true if inserted. */
export function insertRowOrIgnore(args: {
  table: TableName
  keys: Record<string, unknown>
  insert: object
}): boolean {
  const hit = runGet<{ ok: number }>(existsCompiled(args.table, args.keys))
  if (hit) return false
  runExec(insertCompiled(args.table, args.insert))
  return true
}

/** Fetch one row by key columns (for coalesce-style upserts). */
export function getRowByKeys<T extends Record<string, unknown>>(
  table: TableName,
  keys: Record<string, unknown>,
): T | undefined {
  let q = getPlatformDb().selectFrom(table as never).selectAll()
  for (const [col, value] of Object.entries(keys)) {
    q = q.where(col as never, "=", value as never)
  }
  return runGet<T>(q.compile())
}
