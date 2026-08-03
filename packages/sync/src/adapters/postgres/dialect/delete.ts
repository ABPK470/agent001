/**
 * Postgres DELETE batch via USING (VALUES …).
 */

import { quotePgIdent, quotePgTable, quoteSqlLiteral } from "@mia/sql-kit"
import type { WarehouseDeleteSqlInput } from "../../../ports/warehouse-dialect.js"

const BATCH = 500

export function pgDeleteBatchSql(input: WarehouseDeleteSqlInput): string {
  if (input.rows.length === 0) return "SELECT 1 WHERE false"

  const qn = quotePgTable(input.table)
  const pkColumns = input.pkColumns
  const colList = pkColumns.map((c) => quotePgIdent(c)).join(", ")
  const pkOn = pkColumns.map((c) => `T.${quotePgIdent(c)} = S.${quotePgIdent(c)}`).join(" AND ")

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
      `DELETE FROM ${qn} AS T USING (VALUES ${valuesList}) AS S(${colList}) WHERE ${pkOn}`,
    )
  }
  return batches.join(";\n")
}
