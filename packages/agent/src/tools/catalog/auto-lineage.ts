import type { CatalogTable, LineageSource, ViewLineage } from "./types.js"

// ── Helpers ───────────────────────────────────────────────────────

/**
 * Extract a human-readable business area label from an object's qualified name.
 *   publish.MappingTransactionalBankingRules → "Transactional Banking Rules"
 *   publish.Revenue                          → "Revenue"
 *   fact.CommissionAllocation                → "Commission Allocation"
 *   dim.Client                               → "Client"
 */
function extractBusinessArea(qualifiedName: string): string {
  const name = qualifiedName.includes(".") ? qualifiedName.split(".").pop()! : qualifiedName
  // Drop leading "Mapping" prefix from publish mapping views
  const stripped = name.startsWith("Mapping") ? name.slice("Mapping".length) : name
  // CamelCase → spaced words
  return stripped
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
}

/**
 * Group a source by its schema. Generic — works for any DWH schema layout.
 * Curated lineage.json entries replace auto entries for the same view key,
 * so these generic group names only surface for views not in lineage.json.
 */
function extractGroup(qualifiedName: string): string {
  const schema = qualifiedName.includes(".") ? qualifiedName.split(".")[0] : "other"
  const schemaGroups: Record<string, string> = {
    fact:         "Fact Layer",
    dim:          "Dimension Layer",
    publish:      "Publish Layer",
    list:         "Reference Data",
    etl:          "ETL Processing",
    archive:      "Archive",
    stage:        "Staging",
    staging:      "Staging",
    dbo:          "Default Schema",
    persistedview: "Persisted Views",
  }
  return schemaGroups[schema.toLowerCase()] ?? schema
}

// ── Public interface ──────────────────────────────────────────────

/** A row from Q_FULL_VIEW_DEPS. */
export interface ViewDepRow {
  viewName: string    // e.g. "publish.Revenue"
  sourceName: string  // e.g. "fact.CommissionAllocation"
  sourceType: string  // "U" = table, "V" = view
}

/**
 * Build comprehensive auto-lineage entries for **every view** in the catalog.
 *
 * Called once at catalog build time with the results from Q_FULL_VIEW_DEPS.
 * Produces one ViewLineage per view that has any direct dependency:
 *
 *   • outputColumns: all columns the view exposes (from catalog)
 *   • dimJoins:      always empty — no guessing; hand-curated lineage.json wins
 *   • sources:       every table/view the view directly depends on
 *                    (true, from sys.sql_expression_dependencies)
 *
 * After build(), hand-curated lineage.json entries are loaded via loadLineage()
 * which calls mergeLineage() — that overwrites auto entries for the same view keys,
 * so curation always wins for the views that have it.
 *
 * dimJoins are intentionally NOT auto-detected here. The old naming-convention
 * approach (pkClient → dim.Client) was guesswork. Actual dim joins are only known
 * by reading the view's SQL definition (viewDefinition field) or from lineage.json.
 */
export function buildAutoLineage(
  tables: Map<string, CatalogTable>,
  viewDeps: ViewDepRow[],
): ViewLineage[] {
  // Group dep rows by referencing view
  const depMap = new Map<string, { tableSet: Set<string>; viewSet: Set<string> }>()
  for (const row of viewDeps) {
    if (!depMap.has(row.viewName)) depMap.set(row.viewName, { tableSet: new Set(), viewSet: new Set() })
    const entry = depMap.get(row.viewName)!
    if (row.sourceType === "U") entry.tableSet.add(row.sourceName)
    else entry.viewSet.add(row.sourceName)
  }

  const lineages: ViewLineage[] = []

  for (const [viewKey, { tableSet, viewSet }] of depMap) {
    const view = tables.get(viewKey)
    if (!view || view.type !== "VIEW") continue

    const allSources = [...tableSet, ...viewSet]
    if (allSources.length === 0) continue

    const sources: LineageSource[] = allSources.map((dep) => ({
      qualifiedName: dep,
      businessArea: extractBusinessArea(dep),
      group: extractGroup(dep),
      filter: "",
    }))

    const parts: string[] = []
    if (tableSet.size > 0) parts.push(`${tableSet.size} table${tableSet.size !== 1 ? "s" : ""}`)
    if (viewSet.size > 0)  parts.push(`${viewSet.size} view${viewSet.size !== 1 ? "s" : ""}`)

    lineages.push({
      view: viewKey,
      description: `Auto-discovered: reads from ${parts.join(" + ")}.`,
      outputColumns: view.columns.map((c) => c.name),
      dimJoins: [],   // never guessed — only set from hand-curated lineage.json or extended properties
      sources,
      provenance: "auto",
    })
  }

  return lineages
}
