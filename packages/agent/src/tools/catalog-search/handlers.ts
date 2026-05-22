import { getTenantConfig } from "../../tenant/config.js"
import type { CatalogGraph, CatalogTable } from "../catalog/index.js"
import { fmtPath, fmtRow } from "./formatters.js"

/**
 * Resolve `qualifiedName` to a catalog table, applying the deployment's
 * `mirrorSchema` doctrine when the bare name doesn't hit.
 *
 * Example: in deployments where `mirrorSchema = 'persistedView'`, the wide
 * curated view `publish.Revenue` is also materialised as the 3-part name
 * `persistedView.publish.Revenue`. The LLM and most users refer to the
 * base name (`publish.revenue`); this helper bridges that gap so the
 * lookup succeeds either way. Case-insensitive throughout.
 *
 * Returns the resolved table and the `resolvedVia` annotation so the
 * caller can surface a short note to the LLM ("resolved via mirror…").
 */
function resolveTable(
  catalog: CatalogGraph,
  qualifiedName: string,
): { table: CatalogTable; resolvedVia: "direct" | "mirror" } | null {
  const direct = catalog.getTable(qualifiedName)
  if (direct) return { table: direct, resolvedVia: "direct" }
  const mirrorSchema = getTenantConfig().mirrorSchema
  if (mirrorSchema && !qualifiedName.toLowerCase().startsWith(mirrorSchema.toLowerCase() + ".")) {
    const mirrored = catalog.getTable(`${mirrorSchema}.${qualifiedName}`)
    if (mirrored) return { table: mirrored, resolvedVia: "mirror" }
  }
  return null
}

export function handleStats(catalog: CatalogGraph): string {
  const s = catalog.stats()
  const lines = [
    `Schema Catalog Summary:`,
    `  Schemas: ${s.schemas} | Tables: ${s.tables} | Views: ${s.views}`,
    `  Columns: ${s.columns} | FK relationships: ${s.fks}`,
    `  Total rows: ~${(s.totalRows / 1e6).toFixed(0)}M`,
    "",
    "Largest tables:",
  ]
  for (const t of s.largestTables) {
    lines.push(`  ${t.name}: ${fmtRow(t.rows)}`)
  }
  if (s.largestPublishViews.length > 0) {
    lines.push("", "Largest publish VIEWS (by sum of source table rows):")
    lines.push("  Use inspect_definition(object='publish.ViewName') on each to check for duplicate joins.")
    for (const v of s.largestPublishViews) {
      lines.push(`  ${v.name}: ~${fmtRow(v.sourceRows)} underlying rows`)
    }
  }
  return lines.join("\n")
}

export function handleTable(catalog: CatalogGraph, tableName: string): string {
  const resolved = resolveTable(catalog, tableName)
  if (!resolved) {
    const hits = catalog.search(tableName.replace(".", " "), 3)
    if (hits.length > 0) {
      return `Table '${tableName}' not found. Did you mean:\n${hits.map((h) => `  ${h.table.qualifiedName} (${h.table.type})`).join("\n")}`
    }
    return `Table '${tableName}' not found in catalog. Use search_catalog(search='keyword') to find it.`
  }
  const t = resolved.table
  const header = resolved.resolvedVia === "mirror"
    ? `${t.qualifiedName} (${t.type}${t.rowCount != null ? `, ${fmtRow(t.rowCount)}` : ""}) — resolved via mirror (input was '${tableName}')`
    : `${t.qualifiedName} (${t.type}${t.rowCount != null ? `, ${fmtRow(t.rowCount)}` : ""})`
  const lines = [
    header,
    "",
    "Columns:",
  ]
  for (const c of t.columns) {
    const flags = [c.isPK ? "PK" : "", c.nullable ? "nullable" : "NOT NULL"].filter(Boolean).join(", ")
    lines.push(`  ${c.name} (${c.dataType}${c.maxLength && c.maxLength > 0 ? `(${c.maxLength})` : ""}) [${flags}]`)
  }
  if (t.fkOutgoing.length > 0) {
    lines.push("", "FK Outgoing (this table references):")
    for (const fk of t.fkOutgoing) {
      lines.push(`  ${fk.fromColumn} → ${fk.toSchema}.${fk.toTable}.${fk.toColumn} (${fk.constraint})`)
    }
  }
  if (t.fkIncoming.length > 0) {
    lines.push("", `FK Incoming (${t.fkIncoming.length} tables reference this):`)
    for (const fk of t.fkIncoming.slice(0, 10)) {
      lines.push(`  ${fk.fromSchema}.${fk.fromTable}.${fk.fromColumn} → ${fk.toColumn} (${fk.constraint})`)
    }
    if (t.fkIncoming.length > 10) lines.push(`  ... +${t.fkIncoming.length - 10} more`)
  }
  if (t.viewDefinition) {
    lines.push("", `View SQL: available (${t.viewDefinition.length} chars) — use inspect_definition(object='${t.qualifiedName}') to read the full T-SQL with duplicate-join analysis.`)
  }
  return lines.join("\n")
}

export function handleJoins(catalog: CatalogGraph, key: string): string {
  const resolved = resolveTable(catalog, key)
  if (!resolved) {
    const hits = catalog.search(key.replace(".", " "), 3)
    if (hits.length > 0) {
      return `Table '${key}' not found. Did you mean:\n${hits.map((h) => `  ${h.table.qualifiedName}`).join("\n")}`
    }
    return `Table '${key}' not found in catalog.`
  }
  const t = resolved.table
  const header = resolved.resolvedVia === "mirror"
    ? `Join edges for ${t.qualifiedName} (resolved via mirror from '${key}'):`
    : `Join edges for ${t.qualifiedName}:`
  const lines = [header]

  if (t.fkOutgoing.length > 0) {
    lines.push("", "FK OUTGOING (this table references):")
    for (const fk of t.fkOutgoing) {
      lines.push(`  ${fk.fromColumn} → ${fk.toSchema}.${fk.toTable}.${fk.toColumn}`)
    }
  }
  if (t.fkIncoming.length > 0) {
    lines.push("", `FK INCOMING (${t.fkIncoming.length} tables reference this):`)
    for (const fk of t.fkIncoming.slice(0, 15)) {
      lines.push(`  ${fk.fromSchema}.${fk.fromTable}.${fk.fromColumn} → ${fk.toColumn}`)
    }
    if (t.fkIncoming.length > 15) lines.push(`  ... +${t.fkIncoming.length - 15} more`)
  }

  const implicit = catalog.getImplicitJoins(t.qualifiedName)
  if (implicit.length > 0) {
    lines.push("", `IMPLICIT JOINS (${implicit.length} shared columns with other tables):`)
    for (const edge of implicit) {
      const others = edge.tables.filter((tk) => tk !== t.qualifiedName).slice(0, 8)
      lines.push(`  ${edge.column} (${edge.dataType}) → ${others.join(", ")}${edge.tables.length > 9 ? ` (+${edge.tables.length - 9} more)` : ""}`)
    }
  }

  if (t.fkOutgoing.length === 0 && t.fkIncoming.length === 0 && implicit.length === 0) {
    lines.push("  No join edges found (isolated table).")
  }
  return lines.join("\n")
}

export function handleColumn(catalog: CatalogGraph, colName: string): string {
  const matches = catalog.findTablesWithColumn(colName)
  if (matches.length === 0) {
    return `No tables found with column '${colName}'. Try search_catalog(search='${colName}') for broader matching.`
  }
  const lines = [`Tables with column '${colName}' (${matches.length} found):`, ""]
  for (const { table, column } of matches) {
    lines.push(`  ${table.qualifiedName} (${table.type}${table.rowCount != null ? ", " + fmtRow(table.rowCount) : ""})`)
    lines.push(`    ${column.name} (${column.dataType}${column.isPK ? " PK" : ""})`)
  }
  lines.push("", "These tables can be JOINed on this column.")
  return lines.join("\n")
}

export function handlePath(catalog: CatalogGraph, from: string, to: string): string {
  const paths = catalog.findPath(from, to)
  if (paths.length === 0) {
    return `No FK path found between ${from} and ${to} (max depth 5). Try search_catalog(column='sharedColumn') to find implicit join columns.`
  }
  const lines = [`FK paths from ${from} to ${to}:`]
  for (let i = 0; i < paths.length; i++) {
    lines.push(`\nPath ${i + 1} (${paths[i].length} hop${paths[i].length !== 1 ? "s" : ""}):`)
    lines.push(fmtPath(paths[i]))
  }
  return lines.join("\n")
}

export { handleSearch, handleSys } from "./search-handlers.js"
