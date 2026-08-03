/**
 * Execute a SQL batch on an MSSQL pool — Sync warehouse read/write helper.
 */

import type { ConnectionPool } from "mssql"
import type { WarehouseQueryResult } from "../../ports/warehouse-query.js"

export async function executeMssqlQuery<T>(
  pool: ConnectionPool,
  sqlText: string,
): Promise<WarehouseQueryResult<T>> {
  const result = await pool.request().query<T>(sqlText)
  return {
    recordset: (result.recordset ?? []) as T[],
    rowsAffected: [...(result.rowsAffected ?? [])],
  }
}
