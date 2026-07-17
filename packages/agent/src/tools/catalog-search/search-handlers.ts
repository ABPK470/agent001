/**
 * Search + sys catalog handlers. Extracted from handlers.ts.
 *
 * @module
 */

import type { TableVerdictsReader } from "../../runtime/runtime.js"
import type { CatalogGraph } from "../catalog/index.js"
import { fmtSysEntry, fmtTable } from "./formatters.js"

export function handleSearch(
  catalog: CatalogGraph,
  query: string,
  schemaFilter?: string,
  tableVerdicts?: TableVerdictsReader | null
): string {
  const hits = catalog.search(query, 15, tableVerdicts, schemaFilter)
  const sysHits = catalog.searchSys(query)

  if (hits.length === 0 && sysHits.length === 0) {
    const extra = schemaFilter ? ` (filtered to schema '${schemaFilter}')` : ""
    return `No matches found for '${query}'${extra}. Try different keywords or check spelling.`
  }

  const scopeNote = schemaFilter ? ` (schema: ${schemaFilter})` : ""
  const lines = [`Schema Catalog Search: '${query}'${scopeNote} — ${hits.length} matches`, ""]

  const publishHits = hits.filter((h) => h.table.schema === "publish" || h.table.schema === "persistedView")
  const dataHits = hits.filter(
    (h) => h.table.schema === "fact" || h.table.schema === "dim" || h.table.schema === "ext"
  )
  const otherHits = hits.filter(
    (h) =>
      h.table.schema !== "publish" &&
      h.table.schema !== "persistedView" &&
      h.table.schema !== "fact" &&
      h.table.schema !== "dim" &&
      h.table.schema !== "ext"
  )

  if (publishHits.length > 0) {
    lines.push(" PUBLISH / PERSISTED VIEWS (start here — curated BI layer):")
    for (const h of publishHits) lines.push(fmtTable(h.table, h.matchedColumns, catalog))
  }
  if (dataHits.length > 0) {
    lines.push("", "FACT / DIM / EXT (base data — use if publish doesn't have what you need):")
    for (const h of dataHits) lines.push(fmtTable(h.table, h.matchedColumns, catalog))
  }
  if (otherHits.length > 0) {
    lines.push("", "OTHER:")
    for (const h of otherHits) lines.push(fmtTable(h.table, h.matchedColumns, catalog))
  }

  if (hits.length > 0) {
    lines.push(
      "",
      "Results ranked by: name match + schema tier (publish ★) + row volume + column richness + FK centrality + join connectivity.",
      "Pick the highest-ranked table in the best schema tier. If unsure, compare column lists above.",
      "Next step: explore_mssql_schema(table='schema.Table') to see all columns, then SELECT TOP 5."
    )
  }

  if (sysHits.length > 0) {
    lines.push(
      "",
      `SQL SERVER SYSTEM CATALOG (sys.*) — ${sysHits.length} match${sysHits.length > 1 ? "es" : ""}:`,
      "  These are SQL Server engine internals. Query them with query_mssql — NOT search_catalog.",
      "  Do NOT call search_catalog or explore_mssql_schema for sys.* objects.",
      ""
    )
    for (const entry of sysHits) {
      lines.push(fmtSysEntry(entry))
    }
  }

  return lines.join("\n")
}

/**
 * Dedicated sys catalog lookup — searches only sys.* objects.
 */
export function handleSys(catalog: CatalogGraph, query: string): string {
  const directEntry = catalog.getSysEntry(query)
  if (directEntry) {
    const lines = [`SQL Server sys object: ${directEntry.qualifiedName}`, ""]
    if (directEntry.columns.length > 0) {
      lines.push(`Columns (${directEntry.columns.length}):`)
      for (const col of directEntry.columns) {
        lines.push(`  ${col.name} (${col.dataType})`)
      }
    }
    lines.push(
      "",
      `IMPORTANT: Query this with query_mssql — NOT search_catalog or explore_mssql_schema.`,
      `sys.* objects are SQL Server engine internals, not in the user table catalog.`
    )
    return lines.join("\n")
  }

  const hits = catalog.searchSys(query, 8)
  if (hits.length === 0) {
    return (
      `No sys catalog matches for '${query}'.\n` +
      `The sys catalog covers: columnstore internals, index health, query performance, ` +
      `wait stats, locking, memory, partitioning, FK constraints, statistics, HA/Always On, ` +
      `and server configuration.\n` +
      `Try: tombstone, fragmentation, missing index, wait stats, locking, memory, HA, ` +
      `columnstore, partition, statistics, slow query.`
    )
  }

  const lines = [
    `SQL Server System Catalog Search: '${query}' — ${hits.length} sys match${hits.length > 1 ? "es" : ""}`,
    "Query all of these with query_mssql — NOT search_catalog or explore_mssql_schema.",
    ""
  ]
  for (const entry of hits) {
    lines.push(fmtSysEntry(entry))
    lines.push("")
  }
  return lines.join("\n")
}
