/**
 * Begin a warehouse transaction on the target Sync environment.
 */

import type { ConnectionPool } from "mssql"
import sqlMod from "mssql"
import type { Pool as PgPool, PoolClient } from "pg"
import type { SyncRuntimeHost } from "../ports/host.js"
import type { WarehouseQueryResult } from "../ports/warehouse-query.js"
import type { WarehouseTx } from "../ports/warehouse-tx.js"
import { resolveWarehousePool } from "./warehouse-connection.js"

export async function beginWarehouseTx(
  host: SyncRuntimeHost,
  connectionName: string,
): Promise<WarehouseTx> {
  const handle = await resolveWarehousePool(host, connectionName)

  if (handle.dialect === "mssql") {
    const pool = handle.pool as ConnectionPool
    const tx = new sqlMod.Transaction(pool)
    await tx.begin()
    let finished = false
    return {
      dialect: "mssql",
      async query<T>(sqlText: string): Promise<WarehouseQueryResult<T>> {
        const result = await tx.request().query<T>(sqlText)
        return {
          recordset: (result.recordset ?? []) as T[],
          rowsAffected: [...(result.rowsAffected ?? [])],
        }
      },
      async commit(): Promise<void> {
        if (finished) return
        finished = true
        await tx.commit()
      },
      async rollback(): Promise<void> {
        if (finished) return
        finished = true
        try {
          await tx.rollback()
        } catch (err: unknown) {
          console.error("[mia]", err)
        }
      },
    }
  }

  const pool = handle.pool as PgPool
  const client: PoolClient = await pool.connect()
  await client.query("BEGIN")
  let finished = false
  return {
    dialect: "postgres",
    async query<T>(sqlText: string): Promise<WarehouseQueryResult<T>> {
      const result = await client.query(sqlText)
      const rowCount = typeof result.rowCount === "number" ? result.rowCount : result.rows.length
      return {
        recordset: result.rows as T[],
        rowsAffected: [rowCount],
      }
    },
    async commit(): Promise<void> {
      if (finished) return
      finished = true
      try {
        await client.query("COMMIT")
      } finally {
        client.release()
      }
    },
    async rollback(): Promise<void> {
      if (finished) return
      finished = true
      try {
        await client.query("ROLLBACK")
      } catch (err: unknown) {
        console.error("[mia]", err)
      } finally {
        client.release()
      }
    },
  }
}
