/**
 * Culture-invariant per-column CONVERT + HASHBYTES fingerprint SELECT.
 */

import type { WarehouseHashSelectInput } from "../../../ports/warehouse-dialect.js"
import { quoteMssqlTable } from "@mia/sql-kit"
import { MSSQL_DETERMINISTIC_SESSION_PREFIX } from "./session.js"

/** Build a culture-invariant SQL expression that converts `[col]` to NVARCHAR for hashing. */
export function mssqlHashExpr(col: { name: string; systemType: string }): string {
  const c = `[${col.name}]`
  switch (col.systemType) {
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      return `CONVERT(NVARCHAR(33), ${c}, 126)`
    case "date":
      return `CONVERT(NVARCHAR(10), ${c}, 23)`
    case "time":
      return `CONVERT(NVARCHAR(16), ${c}, 114)`
    case "float":
    case "real":
      return `CONVERT(NVARCHAR(64), ${c}, 2)`
    case "money":
    case "smallmoney":
      return `CONVERT(NVARCHAR(32), ${c}, 2)`
    case "binary":
    case "varbinary":
    case "image":
    case "timestamp":
    case "rowversion":
      return `CONVERT(NVARCHAR(MAX), ${c}, 1)`
    case "uniqueidentifier":
      return `CONVERT(NVARCHAR(36), ${c})`
    case "xml":
    case "hierarchyid":
    case "geography":
    case "geometry":
    case "sql_variant":
      return `CONVERT(NVARCHAR(MAX), CONVERT(VARBINARY(MAX), ${c}), 1)`
    default:
      return `CAST(${c} AS NVARCHAR(MAX))`
  }
}

export function mssqlHashSelectSql(input: WarehouseHashSelectInput): string {
  const pkSelect = input.pkColumns.map((c) => `[${c}]`).join(", ")
  const hashArgs = input.hashColumns.map(mssqlHashExpr).join(", ")
  return (
    MSSQL_DETERMINISTIC_SESSION_PREFIX +
    `SELECT ${pkSelect}, ` +
    `HASHBYTES('SHA2_256', ISNULL(CONCAT_WS('|', ${hashArgs}), '')) AS rowHash ` +
    `FROM ${quoteMssqlTable(input.table)} WHERE ${input.whereSql}`
  )
}
