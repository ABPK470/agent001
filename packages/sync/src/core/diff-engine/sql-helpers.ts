/**
 * Low-level SQL helpers for the diff engine (pure).
 *
 * Identifier quoting, transient-error detection, per-type culture-invariant
 * CONVERT expressions for HASHBYTES, and SQL literal coercion.
 *
 * @module
 */

import { isTransientMssqlError, quoteMssqlTable, quoteSqlLiteral } from "@mia/sql-kit"
import type { PkHashRow } from "../../domain/diff-engine/types.js"

export { isTransientMssqlError }

/** Bracket-quote a `schema.table` identifier → `[schema].[table]`. */
export function qtable(name: string): string {
  return quoteMssqlTable(name)
}

/** SQL literal for use in IN / equality clauses. */
export function quoteValue(v: unknown): string {
  return quoteSqlLiteral(v)
}

/** Same as quoteValue but with single quotes for non-numeric/bool — used in human-facing summaries. */
export function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return `'${String(v)}'`
}

/**
 * Build a WHERE clause that matches all rows in `rows` by their PK values.
 * Single-column PK → `[pk] IN (v1, v2, ...)` (efficient index seek).
 * Composite PK → `([pk1] = v1 AND [pk2] = v2) OR (...)` (row-constructor).
 */
export function buildBatchWhere(rows: PkHashRow[], pkColumns: string[]): string {
  if (pkColumns.length === 1) {
    const col = pkColumns[0]!
    const values = rows.map((r) => quoteValue(r.pkValues[col])).join(", ")
    return `[${col}] IN (${values})`
  }
  // Composite PK — OR of AND-ed equality predicates.
  const clauses = rows.map(
    (r) => "(" + pkColumns.map((c) => `[${c}] = ${quoteValue(r.pkValues[c])}`).join(" AND ") + ")"
  )
  return clauses.join(" OR ")
}
