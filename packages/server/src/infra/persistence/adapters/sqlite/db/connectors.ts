/**
 * Connector persistence — CRUD over the `connectors` table.
 *
 * First platform repo on the schema toolkit: Kysely builds SQL; better-sqlite3
 * executes it (sync façade during PlatformStore async cutover).
 */

import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { sql } from "kysely"
import { getDbPath } from "../connection.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"

export interface DbConnector {
  id: string
  kind: string
  body_json: string
  enabled: number
  created_at: string
  updated_at: string
  updated_by: string | null
}

export async function listConnectors(): Promise<DbConnector[]> {
  const compiled = getPlatformDb()
    .selectFrom("connectors")
    .selectAll()
    .orderBy("id")
    .compile()
  return await runAllAsync<DbConnector>(compiled)
}

export async function getConnector(id: string): Promise<DbConnector | undefined> {
  const compiled = getPlatformDb()
    .selectFrom("connectors")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return await runGetAsync<DbConnector>(compiled)
}

export async function saveConnector(row: DbConnector): Promise<void> {
  const existing = await getConnector(row.id)
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
    await runExecAsync(compiled)
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
  await runExecAsync(compiled)
}

export async function deleteConnector(id: string): Promise<void> {
  const compiled = getPlatformDb()
    .deleteFrom("connectors")
    .where("id", "=", id)
    .compile()
  await runExecAsync(compiled)
}

export async function countConnectors(): Promise<number> {
  const compiled = getPlatformDb()
    .selectFrom("connectors")
    .select(sql<number>`count(*)`.as("count"))
    .compile()
  const row = await runGetAsync<{ count: number | bigint }>(compiled)
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
