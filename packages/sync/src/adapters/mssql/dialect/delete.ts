/**
 * Temp-table + DELETE batch SQL.
 */

import { quoteMssqlTable, quoteSqlLiteral } from "@mia/sql-kit"
import type { WarehouseDeleteSqlInput } from "../../../ports/warehouse-dialect.js"

const BATCH = 500

export function mssqlDeleteBatchSql(input: WarehouseDeleteSqlInput): string {
  const qn = quoteMssqlTable(input.table)
  const pkColumns = input.pkColumns
  const pkOn = pkColumns.map((c) => `T.[${c}] = S.[${c}]`).join(" AND ")

  const batches: string[] = []
  for (let i = 0; i < input.rows.length; i += BATCH) {
    const batch = input.rows.slice(i, i + BATCH)
    const valuesList = batch
      .map((row) => {
        const vals = pkColumns.map((c) => quoteSqlLiteral(row[c]))
        return `(${vals.join(", ")})`
      })
      .join(",\n")
    batches.push(
      `INSERT INTO #syncDelPk (${pkColumns.map((c) => `[${c}]`).join(", ")}) VALUES ${valuesList}`,
    )
  }

  const tempCreate = `SELECT TOP 0 ${pkColumns.map((c) => `a.[${c}]`).join(", ")} INTO #syncDelPk FROM ${qn} a LEFT JOIN ${qn} b ON 1 = 0`
  return [
    tempCreate,
    ...batches,
    `DELETE T FROM ${qn} T
     INNER JOIN #syncDelPk S ON ${pkOn}`,
    `DROP TABLE #syncDelPk`,
  ].join(";\n")
}
