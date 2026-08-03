/**
 * Connector persistence — CRUD over the `connectors` table.
 *
 * First platform repo on the schema toolkit: Kysely builds SQL; better-sqlite3
 * executes it (sync façade during PlatformStore async cutover).
 */

import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { sql } from "kysely"
import { getDb, getDbPath } from "../connection.js"
import { getPlatformDb } from "../../../schema/kysely.js"

export interface DbConnector {
  id: string
  kind: string
  body_json: string
  enabled: number
  created_at: string
  updated_at: string
  updated_by: string | null
}

function runAll<T>(compiled: { sql: string; parameters: readonly unknown[] }): T[] {
  return getDb().prepare(compiled.sql).all(...compiled.parameters) as T[]
}

function runGet<T>(compiled: { sql: string; parameters: readonly unknown[] }): T | undefined {
  return getDb().prepare(compiled.sql).get(...compiled.parameters) as T | undefined
}

function runExec(compiled: { sql: string; parameters: readonly unknown[] }): void {
  getDb().prepare(compiled.sql).run(...compiled.parameters)
}

export function listConnectors(): DbConnector[] {
  const compiled = getPlatformDb()
    .selectFrom("connectors")
    .selectAll()
    .orderBy("id")
    .compile()
  return runAll<DbConnector>(compiled)
}

export function getConnector(id: string): DbConnector | undefined {
  const compiled = getPlatformDb()
    .selectFrom("connectors")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<DbConnector>(compiled)
}

export function saveConnector(row: DbConnector): void {
  const existing = getConnector(row.id)
  if (existing) {
    const compiled = getPlatformDb()
      .updateTable("connectors")
      .set({
        kind: row.kind,
        body_json: row.body_json,
        enabled: row.enabled,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      })
      .where("id", "=", row.id)
      .compile()
    runExec(compiled)
    return
  }
  const compiled = getPlatformDb()
    .insertInto("connectors")
    .values({
      id: row.id,
      kind: row.kind,
      body_json: row.body_json,
      enabled: row.enabled,
      created_at: row.created_at,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    })
    .compile()
  runExec(compiled)
}

export function deleteConnector(id: string): void {
  const compiled = getPlatformDb()
    .deleteFrom("connectors")
    .where("id", "=", id)
    .compile()
  runExec(compiled)
}

export function countConnectors(): number {
  const compiled = getPlatformDb()
    .selectFrom("connectors")
    .select(sql<number>`count(*)`.as("count"))
    .compile()
  const row = runGet<{ count: number | bigint }>(compiled)
  return Number(row?.count ?? 0)
}

/**
 * Count enabled `mssql` connectors without booting the persistence layer.
 * Opens the SQLite file read-only (no migrations). Returns 0 when absent.
 */
export function countEnabledMssqlConnectorsReadonly(): number {
  const path = getDbPath()
  if (!existsSync(path)) return 0
  try {
    const conn = new Database(path, { readonly: true })
    try {
      const row = conn
        .prepare("SELECT COUNT(*) AS count FROM connectors WHERE kind = 'mssql' AND enabled = 1")
        .get() as { count: number } | undefined
      return row?.count ?? 0
    } finally {
      conn.close()
    }
  } catch {
    return 0
  }
}
