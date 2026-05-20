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
    // Only the hand-curated lineage entries are worth naming in the prompt
    // — they carry business context the agent can't rediscover (dim joins,
    // business-area tags, filters). Auto-derived entries are just "every
    // view has a parsed SQL definition" — that's discovery work, not
    // prompt-worthy. Curation can come from two sources:
    //   - extended-properties: DBA-authored, lives in sys.extended_properties
    //     on the live DB (north-star — co-located with the schema, cannot
    //     silently drift). See lineage-extended-properties.ts.
    //   - curation-file: hand-curated JSON file (deploy/mssql/publish-views-curation.json), transitional fallback.
    // Drift annotations come from lineage-validator.ts which re-checks every
    // curated entry against the live catalog on load; the refresh-hint text
    // is driven from provenance so the agent (and the human reading the
    // trace) is told WHERE to fix a stale entry.
    const curatedEntries = lineageViews
      .map((v) => graph.getLineage(v))
      .filter((l): l is NonNullable<typeof l> => l != null && l.provenance !== "auto")
    const autoCount = lineageViews.length - curatedEntries.length
    if (curatedEntries.length > 0) {
      const annotated = curatedEntries.map((l) => {
        const v = l.validation
        if (!v) return l.view
        if (v.viewMissing) return `${l.view} [STALE: view missing]`
        const drift = v.droppedSources.length + v.droppedDims.length + v.droppedColumns.length
        return drift > 0 ? `${l.view} [partial: ${drift} stale]` : l.view
      })
      const fromExt = curatedEntries.filter((l) => l.provenance === "extended-properties").length
      const fromJson = curatedEntries.filter((l) => l.provenance === "curation-file").length
      const stale = curatedEntries.filter((l) => {
        const v = l.validation
        return v != null && (v.viewMissing || v.droppedSources.length + v.droppedDims.length + v.droppedColumns.length > 0)
      })
      const driftHints: string[] = []
      if (stale.some((l) => l.provenance === "extended-properties")) driftHints.push("refresh extended properties on the affected views")
      if (stale.some((l) => l.provenance === "curation-file"))      driftHints.push("refresh deploy/mssql/publish-views-curation.json")
      const driftNote = driftHints.length > 0
        ? ` (${stale.length} partially stale — ${driftHints.join("; ")})`
        : ""
      const provenanceBreakdown = fromJson > 0
        ? `${fromExt} from DB extended properties, ${fromJson} from publish-views-curation.json (pending migration)`
        : `${fromExt} from DB extended properties`
      lines.push(`Curated lineage maps (${curatedEntries.length} hand-authored — ${provenanceBreakdown})${driftNote}: ${annotated.join(", ")} — use search_catalog(lineage='view') for the full map.`)
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
