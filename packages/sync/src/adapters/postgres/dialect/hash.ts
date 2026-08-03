/**
 * Postgres fingerprint SELECT — digest(sha256) over pipe-joined text.
 */

import { quotePgIdent, quotePgTable } from "@mia/sql-kit"
import type { WarehouseHashSelectInput } from "../../../ports/warehouse-dialect.js"
import { POSTGRES_DETERMINISTIC_SESSION_PREFIX } from "./session.js"

function pgHashExpr(col: { name: string; systemType: string }): string {
  const c = quotePgIdent(col.name)
  switch (col.systemType) {
    case "timestamp without time zone":
    case "timestamp with time zone":
    case "timestamp":
    case "timestamptz":
      return `to_char(${c}, 'YYYY-MM-DD"T"HH24:MI:SS.MS')`
    case "date":
      return `to_char(${c}, 'YYYY-MM-DD')`
    case "time without time zone":
    case "time with time zone":
    case "time":
    case "timetz":
      return `to_char(${c}, 'HH24:MI:SS.MS')`
    case "bytea":
      return `encode(${c}, 'hex')`
    case "uuid":
      return `${c}::text`
    default:
      return `${c}::text`
  }
}

export function pgHashSelectSql(input: WarehouseHashSelectInput): string {
  const pkSelect = input.pkColumns.map((c) => quotePgIdent(c)).join(", ")
  const hashArgs = input.hashColumns.map(pgHashExpr).join(", ")
  return (
    POSTGRES_DETERMINISTIC_SESSION_PREFIX +
    `SELECT ${pkSelect}, ` +
    `digest(COALESCE(concat_ws('|', ${hashArgs}), ''), 'sha256') AS "rowHash" ` +
    `FROM ${quotePgTable(input.table)} WHERE ${input.whereSql}`
  )
}
