import type { CatalogGraph, ConceptPathResult, ViewLineage } from "../catalog.js"
import { fmtLineage, fmtPath, fmtRow, fmtSysEntry, fmtTable } from "./formatters.js"

export function handleStats(catalog: CatalogGraph): string {
  const s = catalog.stats()
  const lineageViews = catalog.listLineage()
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
  if (lineageViews.length > 0) {
    lines.push("", `Lineage maps available: ${lineageViews.join(", ")}`)
    lines.push("  Use search_catalog(lineage='view') to explore.")
  }
  return lines.join("\n")
}

export function handleLineage(catalog: CatalogGraph, viewName: string): string {
  const lineage = catalog.getLineage(viewName)
  if (lineage) return fmtLineage(lineage)

  // Check if it's a source in another view's lineage
  const parents = catalog.getLineageParents(viewName)
  if (parents.length > 0) {
    const parentInfo = parents.map((p) => `  ${p.view} (as "${p.businessArea}")`).join("\n")
    return `No standalone lineage map for '${viewName}', but it feeds into:\n${parentInfo}\n\nUse search_catalog(lineage='${parents[0].view}') to see the full map.`
  }

  const available = catalog.listLineage()
  if (available.length > 0) {
    return `No lineage map for '${viewName}'. Available lineage maps: ${available.join(", ")}`
  }
  return `No lineage maps loaded. Lineage maps are curated files loaded at server startup.`
}

export function handleConcepts(catalog: CatalogGraph, key: string): string {
  const t = catalog.getTable(key)
  if (!t) {
    const hits = catalog.search(key.replace(".", " "), 3)
    if (hits.length > 0) {
      return `Table '${key}' not found. Did you mean:\n${hits.map((h) => `  ${h.table.qualifiedName}`).join("\n")}`
    }
    return `Table '${key}' not found in catalog. Use search_catalog(search='keyword') to find it.`
  }
  const concepts = catalog.getTableConcepts(key)
  if (concepts.length === 0) {
    const allConcepts = catalog.listConcepts()
    const all = allConcepts.map((c) => `${c.concept} (${c.tables.length} sources)`).join(", ")
    return all
      ? `No concept tags for '${key}'. This table doesn't appear as a source in any lineage map.\nLoaded concepts: ${all}`
      : `No concept tags for '${key}'. No lineage maps are loaded yet.`
  }
  const lines = [`Business concepts for ${key} (${concepts.length}):`, ""]
  for (const c of concepts) {
    const node = catalog.getConcept(c.concept)
    lines.push(`  ★ ${c.concept}`)
    lines.push(`    Aggregated by: ${c.sourceView}`)
    lines.push(`    ${c.description}`)
    lines.push(`    ${node?.tables.length ?? "?"} contributing sources across groups: ${node?.businessGroups.join(", ") ?? "unknown"}`)
    lines.push(`    Use search_catalog(lineage='${c.sourceView}') to see the full source map.`)
    lines.push(`    Use search_catalog(concept_path=['${key}', '${c.sourceView}']) to trace the join path.`)
    lines.push("")
  }
  return lines.join("\n")
}

export function handleConceptPath(catalog: CatalogGraph, from: string, to: string): string {
  const fkPaths = catalog.findPath(from, to)
  const conceptPaths: ConceptPathResult[] = catalog.findConceptPath(from, to)

  if (fkPaths.length === 0 && conceptPaths.length === 0) {
    const fromConcepts = catalog.getTableConcepts(from)
    const toConcepts = catalog.getTableConcepts(to)
    const lines = [`No path found between ${from} and ${to} (checked FK, implicit join, and concept edges).`, ""]
    lines.push(fromConcepts.length > 0
      ? `  ${from} contributes to: ${fromConcepts.map((c) => c.concept).join(", ")}`
      : `  ${from} has no concept tags (not a source in any lineage map).`)
    lines.push(toConcepts.length > 0
      ? `  ${to} contributes to: ${toConcepts.map((c) => c.concept).join(", ")}`
      : `  ${to} has no concept tags (not a source in any lineage map).`)
    return lines.join("\n")
  }

  const lines = [`Concept-aware paths from ${from} to ${to}:`]
  if (fkPaths.length > 0) {
    lines.push("", `FK paths (${fkPaths.length} — structural):`)
    for (let i = 0; i < fkPaths.length; i++) {
      lines.push(`  Path ${i + 1} (${fkPaths[i].length} hop${fkPaths[i].length !== 1 ? "s" : ""}):`, fmtPath(fkPaths[i]))
    }
  }
  if (conceptPaths.length > 0) {
    lines.push("", `Concept paths (${conceptPaths.length} — semantic):`, "")
    for (let i = 0; i < conceptPaths.length; i++) {
      const p = conceptPaths[i]
      const label = p.conceptsUsed.length > 0 ? ` via concept: ${p.conceptsUsed.join(", ")}` : ""
      lines.push(`  Path ${i + 1} (${p.totalHops} hop${p.totalHops !== 1 ? "s" : ""}${label}):`)
      for (const step of p.steps) {
        const edgeDesc =
          step.edge.type === "fk"
            ? `FK: ${step.edge.fromColumn} → ${step.edge.toColumn}`
            : step.edge.type === "implicit"
              ? `implicit join on ${step.edge.column} (${step.edge.dataType})`
              : `concept: ${step.edge.concept} (via ${step.edge.via})`
        lines.push(`    ${step.from} ──[${edgeDesc}]──> ${step.to}`)
      }
    }
  }
  return lines.join("\n")
}

export function handleTable(catalog: CatalogGraph, tableName: string): string {
  const t = catalog.getTable(tableName)
  if (!t) {
    const hits = catalog.search(tableName.replace(".", " "), 3)
    if (hits.length > 0) {
      return `Table '${tableName}' not found. Did you mean:\n${hits.map((h) => `  ${h.table.qualifiedName} (${h.table.type})`).join("\n")}`
    }
    return `Table '${tableName}' not found in catalog. Use search_catalog(search='keyword') to find it.`
  }
  const lines = [
    `${t.qualifiedName} (${t.type}${t.rowCount != null ? `, ${fmtRow(t.rowCount)}` : ""})`,
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
  const t = catalog.getTable(key)
  if (!t) {
    const hits = catalog.search(key.replace(".", " "), 3)
    if (hits.length > 0) {
      return `Table '${key}' not found. Did you mean:\n${hits.map((h) => `  ${h.table.qualifiedName}`).join("\n")}`
    }
    return `Table '${key}' not found in catalog.`
  }
  const lines = [`Join edges for ${t.qualifiedName}:`]

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

  const implicit = catalog.getImplicitJoins(key)
  if (implicit.length > 0) {
    lines.push("", `IMPLICIT JOINS (${implicit.length} shared columns with other tables):`)
    for (const edge of implicit) {
      const others = edge.tables.filter((tk) => tk !== key).slice(0, 8)
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

export function handleSearch(catalog: CatalogGraph, query: string): string {
  const hits = catalog.search(query)
  const sysHits = catalog.searchSys(query)
  if (hits.length === 0 && sysHits.length === 0) {
    return `No matches found for '${query}'. Try different keywords or check spelling.`
  }

  const lines = [
    `Schema Catalog Search: '${query}' — ${hits.length} matches`,
    "",
  ]

  const publishHits = hits.filter((h) => h.table.schema === "publish" || h.table.schema === "persistedView")
  const dataHits = hits.filter((h) => h.table.schema === "fact" || h.table.schema === "dim" || h.table.schema === "ext")
  const otherHits = hits.filter((h) =>
    h.table.schema !== "publish" && h.table.schema !== "persistedView" &&
    h.table.schema !== "fact" && h.table.schema !== "dim" && h.table.schema !== "ext",
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
      "Next step: explore_mssql_schema(table='schema.Table') to see all columns, then SELECT TOP 5.",
    )
  }

  // If any top result has a lineage map, surface that
  const lineageHints = hits.slice(0, 5)
    .map((h) => catalog.getLineage(h.table.qualifiedName))
    .filter((l): l is ViewLineage => l !== null)
  if (lineageHints.length > 0) {
    lines.push(
      "",
      ` LINEAGE AVAILABLE: ${lineageHints.map((l) => l.view).join(", ")}`,
      `  Use search_catalog(lineage='${lineageHints[0].view}') to see all ${lineageHints[0].sources.length} source views, dimension joins, and business areas.`,
    )
  }

  // Surface sys results when they match — always shown if user tables had 0 hits,
  // or appended as a supplemental section when sys results are relevant
  if (sysHits.length > 0) {
    lines.push(
      "",
      `SQL SERVER SYSTEM CATALOG (sys.*) — ${sysHits.length} match${sysHits.length > 1 ? "es" : ""}:`,
      "  These are SQL Server engine internals. Query them with query_mssql — NOT search_catalog.",
      "  Do NOT call search_catalog or explore_mssql_schema for sys.* objects.",
      "",
    )
    for (const entry of sysHits) {
      lines.push(fmtSysEntry(entry))
    }
  }

  return lines.join("\n")
}

/**
 * Dedicated sys catalog lookup — searches only sys.* objects.
 * Handles search_catalog(sys='tombstone') or search_catalog(sys='sys.dm_db_column_store_row_group_physical_stats').
 */
export function handleSys(catalog: CatalogGraph, query: string): string {
  // Direct lookup: if query looks like a qualified sys object name, get it
  const directEntry = catalog.getSysEntry(query)
  if (directEntry) {
    const lines = [
      `SQL Server sys object: ${directEntry.qualifiedName}`,
      "",
    ]
    if (directEntry.columns.length > 0) {
      lines.push(`Columns (${directEntry.columns.length}):`)
      for (const col of directEntry.columns) {
        lines.push(`  ${col.name} (${col.dataType})`)
      }
    }
    lines.push(
      "",
      `IMPORTANT: Query this with query_mssql — NOT search_catalog or explore_mssql_schema.`,
      `sys.* objects are SQL Server engine internals, not in the user table catalog.`,
    )
    return lines.join("\n")
  }

  // Keyword search
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
    "",
  ]
  for (const entry of hits) {
    lines.push(fmtSysEntry(entry))
    lines.push("")
  }
  return lines.join("\n")
}
