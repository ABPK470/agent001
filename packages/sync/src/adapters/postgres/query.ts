/**
 * Execute a SQL batch on a Postgres pool — Sync warehouse read helper.
 */

import type { Pool } from "pg"
import type { WarehouseQueryResult } from "../../ports/warehouse-query.js"

export async function executePostgresQuery<T>(
  pool: Pool,
  sqlText: string,
): Promise<WarehouseQueryResult<T>> {
  const result = await pool.query(sqlText)
  const rowCount = typeof result.rowCount === "number" ? result.rowCount : result.rows.length
  return {
    recordset: result.rows as T[],
    rowsAffected: [rowCount],
  }
}
