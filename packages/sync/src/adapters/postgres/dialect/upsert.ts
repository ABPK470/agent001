/**
 * Postgres upsert via INSERT … ON CONFLICT DO UPDATE.
 */

import { quotePgIdent, quotePgTable, quoteSqlLiteral } from "@mia/sql-kit"
import type { WarehouseUpsertSqlInput } from "../../../ports/warehouse-dialect.js"

const BATCH = 500

export function pgUpsertBatchSql(input: WarehouseUpsertSqlInput): string {
  if (input.rows.length === 0) return "SELECT 1 WHERE false"

  const qn = quotePgTable(input.table)
  const tempCols = input.tempCols
  const pkColumns = input.pkColumns
  const colList = tempCols.map((c) => quotePgIdent(c)).join(", ")
  const conflict = pkColumns.map((c) => quotePgIdent(c)).join(", ")

  const updateParts: string[] = input.updateCols.map(
    (c) => `${quotePgIdent(c)} = EXCLUDED.${quotePgIdent(c)}`,
  )
  for (const [col, expr] of Object.entries(input.onUpdateStamps)) {
    if (!updateParts.some((part) => part.startsWith(`${quotePgIdent(col)}`))) {
      updateParts.push(`${quotePgIdent(col)} = ${expr}`)
    }
  }

  const insertTargetCols = [...tempCols]
  const insertSelectExprs = [...tempCols.map((c) => `S.${quotePgIdent(c)}`)]
  for (const [col, expr] of Object.entries(input.onInsertStamps)) {
    if (!insertTargetCols.includes(col)) {
      insertTargetCols.push(col)
      insertSelectExprs.push(expr)
    }
  }
  const insertTarget = insertTargetCols.map((c) => quotePgIdent(c)).join(", ")
  const insertSelect = insertSelectExprs.join(", ")

  const batches: string[] = []
  for (let i = 0; i < input.rows.length; i += BATCH) {
    const batch = input.rows.slice(i, i + BATCH)
    const valuesList = batch
      .map((row) => {
        const vals = tempCols.map((c) => quoteSqlLiteral(row[c]))
        return `(${vals.join(", ")})`
      })
      .join(",\n")

    const overriding =
      input.identityCol && input.useIdentityInsert ? " OVERRIDING SYSTEM VALUE" : ""
    const onConflict =
      input.allowUpdate && updateParts.length > 0
        ? `ON CONFLICT (${conflict}) DO UPDATE SET ${updateParts.join(", ")}`
        : `ON CONFLICT (${conflict}) DO NOTHING`

    batches.push(
      `INSERT INTO ${qn} (${insertTarget})${overriding}\n` +
        `SELECT ${insertSelect} FROM (VALUES ${valuesList}) AS S(${colList})\n` +
        onConflict,
    )
  }

  return batches.join(";\n")
}
