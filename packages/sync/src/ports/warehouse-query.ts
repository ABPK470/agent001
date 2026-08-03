/**
 * Dialect-neutral warehouse query result — mssql IResult-compatible surface.
 */

export type WarehouseQueryResult<T = Record<string, unknown>> = {
  recordset: T[]
  rowsAffected: number[]
}
