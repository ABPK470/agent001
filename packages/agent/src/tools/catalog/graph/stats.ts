/**
 * Catalog statistics + prompt-summary formatting.
 * Pure functions over the in-memory graph — no I/O.
 *
 * @module
 */

import type { CatalogGraph } from "../graph.js"
import type { CatalogStats } from "../types.js"

export function computeStats(graph: CatalogGraph): CatalogStats {
  let tables = 0, views = 0, columns = 0, fks = 0, totalRows = 0
  const schemas = new Set<string>()
  const largest: Array<{ name: string; rows: number }> = []

  for (const t of graph.tables.values()) {
    schemas.add(t.schema)
    if (t.type === "TABLE") tables++; else views++
    columns += t.columns.length
    fks += t.fkOutgoing.length
    if (t.rowCount) {
      totalRows += t.rowCount
      largest.push({ name: t.qualifiedName, rows: t.rowCount })
    }
  }
  largest.sort((a, b) => b.rows - a.rows)

  const publishViews: Array<{ name: string; sourceRows: number }> = []
  for (const [name, sourceRows] of graph.viewSourceRows) {
    if (name.startsWith("publish.")) publishViews.push({ name, sourceRows })
  }
  publishViews.sort((a, b) => b.sourceRows - a.sourceRows)

  return {
    schemas: schemas.size,
    tables,
    views,
    columns,
    fks,
    implicitEdges: graph.implicitEdges.length,
    totalRows,
    largestTables: largest.slice(0, 15),
    largestPublishViews: publishViews.slice(0, 15),
  }
}

export function formatPromptSummary(graph: CatalogGraph): string {
  const s = computeStats(graph)
  const age = Math.round((Date.now() - graph.builtAt.getTime()) / 3600000)
  const lineageViews = graph.listLineage()
  const lines = [
    `Schema Catalog (built ${age}h ago): ${s.schemas} schemas, ${s.tables} tables, ${s.views} views, ${s.columns} columns, ${s.fks} FKs, ${s.implicitEdges} implicit join edges.`,
    `Total rows: ~${(s.totalRows / 1e6).toFixed(0)}M.`,
  ]
  if (lineageViews.length > 0) {
    lines.push(`Lineage maps available: ${lineageViews.join(", ")} — use search_catalog(lineage='view') to explore.`)
  }
  const conceptList = graph.listConcepts()
  if (conceptList.length > 0) {
    lines.push(`Business concepts: ${conceptList.map((c) => c.concept).join(", ")} — use search_catalog(concepts='table') for semantic tags, search_catalog(concept_path=['A','B']) to trace cross-concept paths.`)
  }
  return lines.join("\n")
}
