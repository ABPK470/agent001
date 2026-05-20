import type { CatalogGraph } from "./graph/index.js"
import type { ViewLineage } from "./types.js"

/**
 * Validate hand-curated lineage entries against the live CatalogGraph.
 *
 * Why this exists: `deploy/mssql/publish-views-curation.json` is a hand-curated artifact
 * with no automatic refresh — the live database schema can drift (views
 * renamed/dropped, sources removed, columns renamed) and the file stays
 * stale until a human notices. Shipping stale curation to the agent makes
 * it lie with full confidence ("publish.MappingX is a source of Revenue"
 * when publish.MappingX was dropped two months ago).
 *
 * Policy:
 *   1. The live catalog is the source of truth.
 *   2. Every curated `view`, `sources[]`, `dimJoins[]`, `outputColumns[]`
 *      is verified against the live catalog before the agent sees it.
 *   3. Anything that no longer exists is dropped from what reaches the
 *      agent and counted in a per-entry drift report.
 *   4. If the view itself is gone, the entry is demoted to a name-only
 *      stub with a clear staleness marker.
 *   5. The drift report is attached to the entry as `validation` so
 *      formatPromptSummary / handleStats / handleLineage can honestly
 *      surface "(N stale fields hidden — refresh deploy/mssql/publish-views-curation.json)".
 *
 * Forward-looking note: the long-term fix is to derive these fields from
 * SQL `EXTENDED_PROPERTIES` on each view so curation lives next to the
 * schema and stays in sync by construction. This validator is the bridge
 * that keeps the file usable until then.
 */
export interface LineageDriftSummary {
  totalEntries: number
  cleanEntries: number              // no drift detected
  partiallyStaleEntries: number     // some sources/dims/columns dropped
  demotedEntries: string[]          // view itself missing — entry is a stub
  totalDroppedSources: number
  totalDroppedDims: number
  totalDroppedColumns: number
}

export function validateCuratedLineage(
  lineages: ViewLineage[],
  catalog: CatalogGraph,
  connectionName: string,
): { validated: ViewLineage[]; summary: LineageDriftSummary } {
  const verifiedAt = new Date().toISOString()
  const summary: LineageDriftSummary = {
    totalEntries: lineages.length,
    cleanEntries: 0,
    partiallyStaleEntries: 0,
    demotedEntries: [],
    totalDroppedSources: 0,
    totalDroppedDims: 0,
    totalDroppedColumns: 0,
  }

  const validated: ViewLineage[] = []
  for (const entry of lineages) {
    const liveView = catalog.getTable(entry.view)

    // Case A: the view itself no longer exists → demote to a stub so the
    // agent does not act on a fabricated lineage map.
    if (!liveView || liveView.type !== "VIEW") {
      summary.demotedEntries.push(entry.view)
      validated.push({
        view: entry.view,
        description: `[STALE — view not found in live catalog; refresh deploy/mssql/publish-views-curation.json] ${entry.description}`,
        outputColumns: [],
        dimJoins: [],
        sources: [],
        validation: {
          verifiedAt,
          verifiedAgainst: connectionName,
          viewMissing: true,
          droppedSources: entry.sources.map((s) => s.qualifiedName),
          droppedDims: entry.dimJoins.map((d) => d.dimTable),
          droppedColumns: [...entry.outputColumns],
        },
      })
      // eslint-disable-next-line no-console
      console.warn(`[lineage:drift] ${entry.view}: VIEW NOT FOUND in live catalog — entry demoted`)
      continue
    }

    // Case B: validate per-field. Drop what no longer exists; keep the rest.
    const liveColumnSet = new Set(liveView.columns.map((c) => c.name.toLowerCase()))

    const keptSources = entry.sources.filter((s) => {
      const t = catalog.getTable(s.qualifiedName)
      return t != null
    })
    const droppedSources = entry.sources
      .filter((s) => !catalog.getTable(s.qualifiedName))
      .map((s) => s.qualifiedName)

    const keptDims = entry.dimJoins.filter((d) => catalog.getTable(d.dimTable) != null)
    const droppedDims = entry.dimJoins
      .filter((d) => !catalog.getTable(d.dimTable))
      .map((d) => d.dimTable)

    const keptColumns = entry.outputColumns.filter((c) => liveColumnSet.has(c.toLowerCase()))
    const droppedColumns = entry.outputColumns.filter((c) => !liveColumnSet.has(c.toLowerCase()))

    const hasDrift =
      droppedSources.length > 0 || droppedDims.length > 0 || droppedColumns.length > 0

    if (hasDrift) {
      summary.partiallyStaleEntries++
      summary.totalDroppedSources += droppedSources.length
      summary.totalDroppedDims += droppedDims.length
      summary.totalDroppedColumns += droppedColumns.length
      // eslint-disable-next-line no-console
      console.warn(
        `[lineage:drift] ${entry.view}: ` +
          `dropped ${droppedSources.length} source(s), ` +
          `${droppedDims.length} dim(s), ` +
          `${droppedColumns.length} column(s) not in live catalog`,
      )
    } else {
      summary.cleanEntries++
    }

    validated.push({
      view: entry.view,
      description: hasDrift
        ? `[partial — ${droppedSources.length + droppedDims.length + droppedColumns.length} stale fields hidden] ${entry.description}`
        : entry.description,
      outputColumns: keptColumns,
      dimJoins: keptDims,
      sources: keptSources,
      validation: {
        verifiedAt,
        verifiedAgainst: connectionName,
        droppedSources,
        droppedDims,
        droppedColumns,
      },
    })
  }

  if (summary.demotedEntries.length > 0 || summary.partiallyStaleEntries > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[lineage:drift] summary against connection='${connectionName}': ` +
        `${summary.cleanEntries}/${summary.totalEntries} clean, ` +
        `${summary.partiallyStaleEntries} partially stale, ` +
        `${summary.demotedEntries.length} demoted ` +
        `(${summary.totalDroppedSources} sources, ${summary.totalDroppedDims} dims, ` +
        `${summary.totalDroppedColumns} cols pruned) — refresh deploy/mssql/publish-views-curation.json`,
    )
  }

  return { validated, summary }
}
