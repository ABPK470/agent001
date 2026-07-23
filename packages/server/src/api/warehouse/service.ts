import type { ConnectionPool } from "mssql"

export function buildWarehouseSampleRowsQuery(schema: string, table: string, limit: number): string {
  return `SELECT TOP ${limit} * FROM [${schema}].[${table}]`
}

export async function queryWarehouseSampleRows(
  pool: ConnectionPool,
  schema: string,
  table: string,
  limit: number
) {
  return pool.request().query(buildWarehouseSampleRowsQuery(schema, table, limit))
}
