/**
 * Temp-table + MERGE upsert batch SQL.
 */

import { quoteMssqlTable, quoteSqlLiteral } from "@mia/sql-kit"
import type { WarehouseUpsertSqlInput } from "../../../ports/warehouse-dialect.js"

const BATCH = 500

export function mssqlUpsertBatchSql(input: WarehouseUpsertSqlInput): string {
  const qn = quoteMssqlTable(input.table)
  const tempCols = input.tempCols
  const pkColumns = input.pkColumns
  const identityCol = input.identityCol

  const batches: string[] = []
  for (let i = 0; i < input.rows.length; i += BATCH) {
    const batch = input.rows.slice(i, i + BATCH)
    const valuesList = batch
      .map((row) => {
        const vals = tempCols.map((c) => quoteSqlLiteral(row[c]))
        return `(${vals.join(", ")})`
      })
      .join(",\n")
    batches.push(
      `INSERT INTO #syncSrc (${tempCols.map((c) => `[${c}]`).join(", ")}) VALUES ${valuesList}`,
    )
  }

  const tempColList = tempCols.map((c) => `[${c}]`).join(", ")
  const tempCreate = identityCol
    ? `SELECT TOP 0 ${tempCols.map((c) => `a.[${c}]`).join(", ")} INTO #syncSrc FROM ${qn} a LEFT JOIN ${qn} b ON 1 = 0`
    : `SELECT TOP 0 ${tempColList} INTO #syncSrc FROM ${qn}`

  const pkOn = pkColumns.map((c) => `T.[${c}] = S.[${c}]`).join(" AND ")
  const updateParts: string[] = input.updateCols.map((c) => `T.[${c}] = S.[${c}]`)
  for (const [col, expr] of Object.entries(input.onUpdateStamps)) {
    if (!updateParts.some((part) => part.startsWith(`T.[${col}]`))) {
      updateParts.push(`T.[${col}] = ${expr}`)
    }
  }
  const updateSet =
    input.allowUpdate && updateParts.length > 0
      ? `WHEN MATCHED THEN UPDATE SET ${updateParts.join(", ")}`
      : ""

  const insertTargetCols = [...tempCols]
  const insertValueExprs = [...tempCols.map((c) => `S.[${c}]`)]
  for (const [col, expr] of Object.entries(input.onInsertStamps)) {
    if (!insertTargetCols.includes(col)) {
      insertTargetCols.push(col)
      insertValueExprs.push(expr)
    }
  }
  const insertTarget = insertTargetCols.map((c) => `[${c}]`).join(", ")
  const insertValues = insertValueExprs.join(", ")

  const mergeStmt = [
    input.useIdentityInsert ? `SET IDENTITY_INSERT ${qn} ON` : null,
    `MERGE ${qn} AS T`,
    `USING #syncSrc AS S ON ${pkOn}`,
    updateSet,
    `WHEN NOT MATCHED BY TARGET THEN INSERT (${insertTarget}) VALUES (${insertValues})`,
    `;`,
    identityCol && input.useIdentityInsert ? `SET IDENTITY_INSERT ${qn} OFF` : null,
  ]
    .filter(Boolean)
    .join("\n")

  return [tempCreate, ...batches, mergeStmt, `DROP TABLE #syncSrc`].join(";\n")
}
