/**
 * Custom value sources — operator-defined target-sql lookups only.
 *
 * Builtins (planEntityId, contractName, …) are ValueSource enum variants in value-source.ts.
 */

import { validateCatalogId } from "./catalog-id.js"

export interface CustomValueSourceDefinition {
  description: string
  query: string
  resultColumn: string
  resultType?: "string" | "number"
}

export type CustomValueSourceCatalog = Record<string, CustomValueSourceDefinition>

export function validateTargetSqlQuery(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed) return "SQL query is required."
  if (!/^\s*SELECT\b/i.test(trimmed)) return "Query must be a SELECT statement."
  if (!/@entityId\b/.test(trimmed)) return "Query must reference @entityId (sync plan entity id)."
  if (/;/.test(trimmed.replace(/'[^']*'/g, ""))) return "Query must not contain statement separators."
  return null
}

export function inferTargetSqlResultType(resultColumn: string): "string" | "number" {
  const column = resultColumn.trim()
  if (!column) return "string"
  if (/Id$/i.test(column)) return "number"
  return "string"
}

export function effectiveTargetSqlResultType(def: {
  resultColumn: string
  resultType?: "string" | "number"
}): "string" | "number" {
  void def.resultType
  return inferTargetSqlResultType(def.resultColumn)
}

export function normalizeCustomValueSourceDefinition(
  def: CustomValueSourceDefinition,
): CustomValueSourceDefinition {
  return {
    ...def,
    resultType: effectiveTargetSqlResultType(def),
  }
}

export function parseCustomValueSourceDefinition(
  raw: unknown,
  id: string,
): CustomValueSourceDefinition {
  const parsed = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<
    CustomValueSourceDefinition & { summary?: string }
  >
  const query = String(parsed.query ?? "").trim()
  const queryError = validateTargetSqlQuery(query)
  if (queryError) throw new Error(`Custom value source "${id}": ${queryError}`)
  const resultColumn = String(parsed.resultColumn ?? "").trim()
  if (!resultColumn) {
    throw new Error(`Custom value source "${id}" requires resultColumn.`)
  }
  return normalizeCustomValueSourceDefinition({
    description: parsed.description?.trim() || "",
    query,
    resultColumn,
    resultType: parsed.resultType,
  })
}

export function customValueSourceCatalogFromRows(
  rows: ReadonlyArray<{ id: string; definition: CustomValueSourceDefinition }>,
): CustomValueSourceCatalog {
  return Object.fromEntries(rows.map((row) => [row.id, row.definition]))
}

export function lookupCustomValueSource(
  catalog: CustomValueSourceCatalog,
  id: string,
): CustomValueSourceDefinition {
  const def = catalog[id]
  if (!def) {
    throw new Error(
      `Unknown custom value source "${id}". Configure it under Sync metadata → Custom value sources.`,
    )
  }
  return def
}

export function formatCustomValueSourcePreview(
  definition: CustomValueSourceDefinition,
  label: string,
  id: string,
): string {
  const trimmed = label.trim() || id
  const tagged = `Query: ${trimmed}`
  return trimmed.startsWith("Query:") ? trimmed : tagged
}

export function validateCustomValueSourceId(id: string): string | null {
  return validateCatalogId(id, "Custom value source id")
}
