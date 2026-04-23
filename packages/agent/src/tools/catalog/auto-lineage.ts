import type { CatalogTable, LineageDimJoin, LineageSource, ViewLineage } from "./types.js"

// ── Helpers ───────────────────────────────────────────────────────

function approxRows(n: number): string {
  if (n >= 1_000_000_000) return `~${(n / 1_000_000_000).toFixed(0)}B`
  if (n >= 1_000_000)     return `~${(n / 1_000_000).toFixed(0)}M`
  if (n >= 1_000)         return `~${(n / 1_000).toFixed(0)}K`
  return `~${n}`
}

/**
 * Auto-detect dimension key joins from a view's output columns.
 * Any column matching /^pk[A-Z]/ where dim.<Suffix> exists in the catalog
 * is treated as a foreign key to that dimension table.
 *
 * pkClient  → dim.Client
 * pkMonth   → dim.Month
 * pkAccount → dim.Account  (flagged as "ALWAYS filter" if rowCount > 1M)
 */
function detectDimJoins(
  view: CatalogTable,
  tables: Map<string, CatalogTable>,
): LineageDimJoin[] {
  const joins: LineageDimJoin[] = []
  const seen = new Set<string>()

  for (const col of view.columns) {
    const cn = col.name
    // Must start with pk + uppercase letter (pkClient, pkMonth, etc.)
    if (!/^pk[A-Z]/.test(cn)) continue

    // pkClient  → suffix = "Client"
    // pk_Client → suffix = "Client" (snake_case variant)
    const suffix = cn.startsWith("pk_") ? cn.slice(3) : cn.slice(2)
    if (!suffix) continue

    // Normalize to Title Case for dim lookup
    const normalized = suffix.charAt(0).toUpperCase() + suffix.slice(1)
    const dimKey = `dim.${normalized}`
    if (seen.has(dimKey)) continue

    const dimTable = tables.get(dimKey)
    if (!dimTable) continue

    seen.add(dimKey)
    const large = dimTable.rowCount != null && dimTable.rowCount > 1_000_000
    joins.push({
      column: cn,
      dimTable: dimKey,
      dimRows: dimTable.rowCount != null ? approxRows(dimTable.rowCount) : "unknown",
      note: large ? "ALWAYS filter — never full scan" : "",
    })
  }

  return joins
}

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
 *   • dimJoins:      auto-detected via pkXxx column naming convention
 *   • sources:       every table/view the view directly depends on
 *
 * After build(), hand-curated lineage.json entries are loaded via loadLineage()
 * which calls mergeLineage() — that overwrites auto entries for the same view keys,
 * so curation always wins for the views that have it.
 *
 * This means:
 *   • publish.Revenue, publish.Balances → rich curated entries (59/10 sources, business groups, filters)
 *   • every other view                  → auto-discovered entries (schema groups, auto dim joins)
 *   • views with zero dependencies      → no lineage entry (e.g. simple synonym views)
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

    const dimJoins = detectDimJoins(view, tables)

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
      dimJoins,
      sources,
    })
  }

  return lineages
}
