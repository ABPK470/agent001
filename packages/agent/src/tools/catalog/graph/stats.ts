/**
 * Catalog statistics + prompt-summary formatting.
 * Pure functions over the in-memory graph — no I/O.
 *
 * @module
 */

import type { CatalogGraph } from "../graph/index.js"
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
    // Only the hand-curated lineage entries (lineage.json) are worth naming
    // in the prompt — they carry business context the agent can't rediscover
    // (dim joins, business-area tags, filters). Auto-derived entries are just
    // "every view has a parsed SQL definition" — that's discovery work,
    // not prompt-worthy. Dumping all of them was inflating every DB-shaped
    // prompt by tens of KB with names like `audit.DailyChequeBalances` that
    // the model can find on demand via search_catalog / explore_mssql_schema.
    const curated = lineageViews.filter((v) => {
      const l = graph.getLineage(v)
      return l != null && !l.description.startsWith("Auto-discovered:")
    })
    const autoCount = lineageViews.length - curated.length
    if (curated.length > 0) {
      lines.push(`Curated lineage maps (${curated.length} hand-authored with business context): ${curated.join(", ")} — use search_catalog(lineage='view') for the full map.`)
      if (autoCount > 0) lines.push(`(+${autoCount} auto-derived view lineages, discover on demand via search_catalog.)`)
    } else {
      lines.push(`Lineage: ${autoCount} views have auto-derived source maps — use search_catalog(lineage='<view>') to fetch a specific one.`)
    }
  }
  const conceptList = graph.listConcepts()
  if (conceptList.length > 0) {
    lines.push(`Business concepts: ${conceptList.map((c) => c.concept).join(", ")} — use search_catalog(concepts='table') for semantic tags, search_catalog(concept_path=['A','B']) to trace cross-concept paths.`)
  }
  return lines.join("\n")
}
