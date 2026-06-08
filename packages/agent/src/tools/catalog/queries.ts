// ── Catalog query facade ────────────────────────────────────────
//
// Generic, first-principles questions you can ask the live catalog WITHOUT
// hardcoding any customer-specific schema, table, or column name. Every
// predicate below is derived from data the catalog already collects:
//
//   • rowCount (from sys.dm_db_partition_stats)        → "how big is this?"
//   • viewSourceRows (Σ underlying physical rowCounts)  → "how big is this VIEW?"
//   • viewDefinition (from sys.sql_modules)             → "what shape is this VIEW?"
//   • lineageMap (extended properties + curation)       → "what feeds this VIEW?"
//   • columns / fkOutgoing / fkIncoming                 → "what keys does this have?"
//
// The whole point: replace name-based checks (`qn === "publish.Revenue"`)
// with shape-based checks (`isExpensiveUnionView(qn)`) so the agent works
// against ANY MSSQL schema with zero code changes.
//
// All accessors are pure and synchronous — they read in-memory catalog
// data only. No SQL is issued from this module.

import { getTenantConfig } from "../../application/shell/tenant-config.js"
import type { CatalogGraph } from "./graph/index.js"
import type { CatalogTable } from "./types.js"

// ── Defaults ─────────────────────────────────────────────────────
//
// These thresholds are universal heuristics, not customer-specific. They
// can be overridden per-call (and will be sourced from tenant-config in
// Phase 1) but the defaults are designed to be sensible on any warehouse:
//
//   • LARGE_OBJECT_ROW_THRESHOLD = 10M — anything above this can't be
//     unfiltered-scanned in a 60s window on commodity hardware.
//   • UNION_BRANCH_THRESHOLD = 8 — empirically, a UNION ALL over ≥8 branches
//     starts to defeat predicate pushdown in the optimiser; below that,
//     direct GROUP BY against the view stays plan-stable.

export const LARGE_OBJECT_ROW_THRESHOLD = 10_000_000
export const UNION_BRANCH_THRESHOLD = 8

// ── Accessor injection ──────────────────────────────────────────
//
// Every query takes an optional accessor callback so tests and the hosted
// server can inject a synthetic or host-scoped catalog (no DB, no fixtures
// pinned to customer names). When omitted, queries degrade to "no catalog"
// instead of consulting ambient runtime state.

export type CatalogAccessor = () => CatalogGraph | null

export function defaultCatalogAccessor(connection = "default"): CatalogGraph | null {
  void connection
  return null
}

// ── Case-insensitive table lookup ────────────────────────────────
//
// SQL identifiers are case-insensitive by default; user queries arrive
// in any case. The CatalogGraph stores keys in their original case, so we
// memoise a lowercase→canonical-key map per catalog identity and consult
// it whenever a public API receives a qualifiedName from query text.

const catalogQueryState = {
  ciIndexCache: null as { catalog: object; lower: Map<string, string> } | null,
  largeIndexCache: null as { catalog: object; threshold: number; names: Set<string> } | null,
  unionIndexCache: null as {
    catalog: object
    threshold: number
    branchCounts: Map<string, number>
  } | null
}

function ciIndex(catalog: CatalogGraph): Map<string, string> {
  if (
    catalogQueryState.ciIndexCache &&
    catalogQueryState.ciIndexCache.catalog === (catalog as unknown as object)
  )
    return catalogQueryState.ciIndexCache.lower
  const lower = new Map<string, string>()
  for (const [key] of catalog.tables) lower.set(key.toLowerCase(), key)
  catalogQueryState.ciIndexCache = { catalog: catalog as unknown as object, lower }
  return lower
}

function getTableCI(catalog: CatalogGraph, qualifiedName: string): CatalogTable | null {
  // Fast path: original case.
  const direct = catalog.getTable(qualifiedName)
  if (direct) return direct
  const canonical = ciIndex(catalog).get(qualifiedName.toLowerCase())
  return canonical ? catalog.getTable(canonical) : null
}

/**
 * Returns the catalog's canonical (original-case) qualified name for the
 * given identifier, doing a case-insensitive lookup. Returns the input
 * unchanged when the object is not in the catalog. Useful for surfacing
 * names in user-facing error messages.
 */
export function canonicalQualifiedName(
  qualifiedName: string,
  options: { accessor?: CatalogAccessor } = {}
): string {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog)
    return (
      getTenantConfig().catalogBootstrap.canonicalQualifiedNames[qualifiedName.toLowerCase()] ?? qualifiedName
    )
  return getTableCI(catalog, qualifiedName)?.qualifiedName ?? qualifiedName
}

// ── Memoised "large objects" index ──────────────────────────────
//
// Computed lazily and invalidated by catalog identity (object reference
// equality). A catalog rebuild swaps the reference and we rebuild the set
// on next call. Avoids walking every table on every isLargeObject() call
// from the hot validation path.

function buildLargeIndex(catalog: CatalogGraph, threshold: number): Set<string> {
  const out = new Set<string>()
  for (const [, t] of catalog.tables) {
    if (t.rowCount != null && t.rowCount >= threshold) {
      out.add(t.qualifiedName.toLowerCase())
    }
  }
  for (const [view, sourceRows] of catalog.viewSourceRows) {
    if (sourceRows >= threshold) out.add(view.toLowerCase())
  }
  return out
}

/** Force-rebuild the cache. Tests call this between catalog swaps. */
export function _resetCatalogQueriesCache(): void {
  catalogQueryState.largeIndexCache = null
  catalogQueryState.unionIndexCache = null
  catalogQueryState.ciIndexCache = null
}

function currentLargeIndex(accessor: CatalogAccessor, threshold: number): Set<string> | null {
  const catalog = accessor()
  if (!catalog) return null
  if (
    catalogQueryState.largeIndexCache &&
    catalogQueryState.largeIndexCache.catalog === (catalog as unknown as object) &&
    catalogQueryState.largeIndexCache.threshold === threshold
  )
    return catalogQueryState.largeIndexCache.names
  const names = buildLargeIndex(catalog, threshold)
  catalogQueryState.largeIndexCache = { catalog: catalog as unknown as object, threshold, names }
  return names
}

// ── Memoised "expensive UNION views" index ──────────────────────

/**
 * Count `UNION ALL` (and bare `UNION`) clauses in a VIEW definition. Returns
 * branchCount = 1 + UNION-clause count, since N UNIONs produce N+1 branches.
 * Returns 1 for views with no UNION (single-branch).
 */
function countUnionBranchesInDefinition(viewDefinition: string): number {
  // Strip comments + string literals so we don't count UNION inside a comment
  // or a quoted string. Whitespace-preserving (line numbers don't matter here).
  const stripped = viewDefinition
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'[^']*'/g, "''")
  // \bUNION\b matches UNION and UNION ALL the same — we only care about
  // the count of branch boundaries.
  const matches = stripped.match(/\bUNION\b/gi)
  return 1 + (matches?.length ?? 0)
}

function buildUnionIndex(catalog: CatalogGraph, threshold: number): Map<string, number> {
  const out = new Map<string, number>()
  for (const [, t] of catalog.tables) {
    if (t.type !== "VIEW" || !t.viewDefinition) continue
    const branchCount = countUnionBranchesInDefinition(t.viewDefinition)
    if (branchCount >= threshold) {
      out.set(t.qualifiedName.toLowerCase(), branchCount)
    }
  }
  return out
}

function currentUnionIndex(accessor: CatalogAccessor, threshold: number): Map<string, number> | null {
  const catalog = accessor()
  if (!catalog) return null
  if (
    catalogQueryState.unionIndexCache &&
    catalogQueryState.unionIndexCache.catalog === (catalog as unknown as object) &&
    catalogQueryState.unionIndexCache.threshold === threshold
  )
    return catalogQueryState.unionIndexCache.branchCounts
  const branchCounts = buildUnionIndex(catalog, threshold)
  catalogQueryState.unionIndexCache = { catalog: catalog as unknown as object, threshold, branchCounts }
  return branchCounts
}

// ── Public predicates ───────────────────────────────────────────

/**
 * Is the given object large enough that unfiltered scans are dangerous?
 *
 * Sources, in order:
 *   1. Live catalog: rowCount ≥ threshold (table) OR viewSourceRows ≥ threshold (view).
 *
 * Before a live catalog is loaded, fall back to a tiny bootstrap allowlist
 * of canonical known-huge UNION views so deep-profile and doctrine guards
 * still protect the agent during early startup and unit tests.
 */
export function isLargeObject(
  qualifiedName: string,
  options: { accessor?: CatalogAccessor; threshold?: number } = {}
): boolean {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const threshold = options.threshold ?? LARGE_OBJECT_ROW_THRESHOLD
  const idx = currentLargeIndex(accessor, threshold)
  if (!idx) return getTenantConfig().catalogBootstrap.largeObjects.includes(qualifiedName.toLowerCase())
  return idx.has(qualifiedName.toLowerCase())
}

/**
 * Returns the lowercased qualifiedName → rowCount/viewSourceRows map for
 * every object currently classified as large. Useful for prompt-time
 * "top expensive objects" lists.
 */
export function listLargeObjects(
  options: { accessor?: CatalogAccessor; threshold?: number } = {}
): ReadonlySet<string> {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const threshold = options.threshold ?? LARGE_OBJECT_ROW_THRESHOLD
  return currentLargeIndex(accessor, threshold) ?? new Set(getTenantConfig().catalogBootstrap.largeObjects)
}

/**
 * Count the UNION ALL branches in a VIEW. Returns 1 for non-UNION views,
 * 0 for tables / unknown objects.
 *
 * Parses the VIEW's viewDefinition. Returns 0 if the object isn't a
 * VIEW or we have no definition to inspect.
 */
export function unionBranchCount(
  qualifiedName: string,
  options: { accessor?: CatalogAccessor } = {}
): number {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog) return getTenantConfig().catalogBootstrap.unionBranchCounts[qualifiedName.toLowerCase()] ?? 0
  const tbl = getTableCI(catalog, qualifiedName)
  if (!tbl || tbl.type !== "VIEW") return 0
  if (tbl.viewDefinition) return countUnionBranchesInDefinition(tbl.viewDefinition)
  return 0
}

/** True iff the object is a VIEW with at least one UNION branch boundary. */
export function isUnionView(qualifiedName: string, options: { accessor?: CatalogAccessor } = {}): boolean {
  return unionBranchCount(qualifiedName, options) >= 2
}

/**
 * True iff the VIEW has ≥ threshold UNION branches. This is the predicate
 * the branch-aggregation doctrine fires on — direct TOP-N + GROUP BY against
 * such a view forces global expansion of every branch and is the canonical
 * cause of timed-out warehouse queries.
 */
export function isExpensiveUnionView(
  qualifiedName: string,
  options: { accessor?: CatalogAccessor; threshold?: number } = {}
): boolean {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const threshold = options.threshold ?? UNION_BRANCH_THRESHOLD
  const idx = currentUnionIndex(accessor, threshold)
  if (!idx) {
    return (
      (getTenantConfig().catalogBootstrap.unionBranchCounts[qualifiedName.toLowerCase()] ?? 0) >= threshold
    )
  }
  return idx.has(qualifiedName.toLowerCase())
}

/** Returns the lowercased qualifiedName → branchCount map of expensive UNION views. */
export function listExpensiveUnionViews(
  options: { accessor?: CatalogAccessor; threshold?: number } = {}
): ReadonlyMap<string, number> {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const threshold = options.threshold ?? UNION_BRANCH_THRESHOLD
  return (
    currentUnionIndex(accessor, threshold) ??
    new Map(
      Object.entries(getTenantConfig().catalogBootstrap.unionBranchCounts).filter(
        ([, branches]) => branches >= threshold
      )
    )
  )
}

// ── Key-column primitives ───────────────────────────────────────

/** Primary-key columns for the table. Empty array for views or tables without PK. */
export function primaryKeyColumns(
  qualifiedName: string,
  options: { accessor?: CatalogAccessor } = {}
): string[] {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog) return []
  const tbl = getTableCI(catalog, qualifiedName)
  if (!tbl) return []
  return tbl.columns.filter((c) => c.isPK).map((c) => c.name)
}

/**
 * Columns whose values are high-cardinality enough that GROUP BY on them
 * fans out per row in a UNION-view scan. Heuristic:
 *
 *   • Primary-key columns of large fact-shaped tables, OR
 *   • Foreign-key OUTGOING columns whose target table has many incoming FKs
 *     (i.e. the target is a centrally-referenced dimension and the column
 *     is the dimension key).
 *
 * No name patterns (no `pkClient` literal match). Works against any naming
 * convention because it consults the live PK/FK metadata.
 */
export function highCardinalityKeyColumns(
  qualifiedName: string,
  options: { accessor?: CatalogAccessor; minTargetIncomingFks?: number } = {}
): string[] {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog)
    return [...(getTenantConfig().catalogBootstrap.highCardinalityKeys[qualifiedName.toLowerCase()] ?? [])]
  const tbl = getTableCI(catalog, qualifiedName)
  if (!tbl) return []
  const minIncoming = options.minTargetIncomingFks ?? 3

  const cols = new Set<string>()
  for (const c of tbl.columns) if (c.isPK) cols.add(c.name)
  for (const fk of tbl.fkOutgoing) {
    const target = getTableCI(catalog, `${fk.toSchema}.${fk.toTable}`)
    if (target && target.fkIncoming.length >= minIncoming) cols.add(fk.fromColumn)
  }
  return [...cols]
}

/**
 * Best-guess date-grain column for the object — the column most likely to
 * carry a "month/date/period" key the agent should filter by. Heuristic:
 *
 *   1. Any FK-OUTGOING column whose target table looks like a calendar
 *      dimension (low rowCount + at least one DATE/DATETIME/SMALLDATETIME
 *      column). Pick the first such column.
 *   2. Otherwise, any column on this object with a DATE/DATETIME type.
 *   3. Otherwise null.
 *
 * Returns the column NAME (not qualified). Works regardless of whether
 * the column is called `pkMonth`, `DateKey`, `period_id`, etc.
 */
export function dateGrainColumn(
  qualifiedName: string,
  options: { accessor?: CatalogAccessor } = {}
): string | null {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog) return null
  const tbl = getTableCI(catalog, qualifiedName)
  if (!tbl) return null

  // 1. FK to a calendar-shaped dimension
  for (const fk of tbl.fkOutgoing) {
    const target = getTableCI(catalog, `${fk.toSchema}.${fk.toTable}`)
    if (!target) continue
    const isSmall = target.rowCount != null && target.rowCount < 100_000 // calendars are small
    const hasDateCol = target.columns.some((c) => isDateType(c.dataType))
    if (isSmall && hasDateCol) return fk.fromColumn
  }
  // 2. Direct date column on this object
  const direct = tbl.columns.find((c) => isDateType(c.dataType))
  return direct ? direct.name : null
}

function isDateType(dataType: string): boolean {
  const t = dataType.toLowerCase()
  return (
    t === "date" || t === "datetime" || t === "datetime2" || t === "smalldatetime" || t === "datetimeoffset"
  )
}

/**
 * Find the canonical "calendar" / "date" dimension for the database: the
 * smallest table whose name OR columns suggest a date dimension. Returns
 * its qualified name (e.g. `dim.Date`, `master.Calendar`, `ref.Period`)
 * or null. Used to fill `<calendarDimensionTable>` placeholders in fix
 * hints.
 *
 * Heuristic (no name match): a TABLE with rowCount < 100k AND at least
 * one DATE/DATETIME column AND a primary key. Returns the smallest such.
 */
export function calendarDimensionTable(options: { accessor?: CatalogAccessor } = {}): string | null {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog) return null
  let best: { qn: string; rows: number } | null = null
  for (const [, t] of catalog.tables) {
    if (t.type !== "TABLE") continue
    if (t.rowCount == null || t.rowCount > 100_000) continue
    if (!t.columns.some((c) => c.isPK)) continue
    if (!t.columns.some((c) => isDateType(c.dataType))) continue
    if (!best || t.rowCount < best.rows) best = { qn: t.qualifiedName, rows: t.rowCount }
  }
  return best?.qn ?? null
}

// ── Mirror / persistedView primitives ───────────────────────────

/**
 * Given a base view qualifiedName, return its materialised mirror if one
 * exists. Mirror convention is configurable: when `mirrorSchema` is "X",
 * the mirror of "publish.Revenue" is looked up under "X.publish.Revenue".
 * Returns null when no mirror schema is configured OR no such table
 * exists in the catalog.
 *
 * NB: the 3-part naming (`<mirrorSchema>.<baseSchema>.<baseName>`) is not
 * standard MSSQL — most deployments will leave `mirrorSchema` unset and
 * this function will always return null. That is FINE: it just means the
 * "prefer mirror over base" doctrine simply doesn't activate for that
 * deployment.
 */
export function persistedMirrorOf(
  qualifiedName: string,
  options: { accessor?: CatalogAccessor; mirrorSchema?: string | null } = {}
): string | null {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const mirrorSchema = options.mirrorSchema ?? null
  if (!mirrorSchema) return null
  const catalog = accessor()
  if (!catalog) {
    const base =
      getTenantConfig().catalogBootstrap.canonicalQualifiedNames[qualifiedName.toLowerCase()] ?? qualifiedName
    const mirrorName = `${mirrorSchema}.${base}`
    return getTenantConfig().catalogBootstrap.canonicalQualifiedNames[mirrorName.toLowerCase()]
      ? mirrorName
      : null
  }
  const mirrorName = `${mirrorSchema}.${qualifiedName}`
  return getTableCI(catalog, mirrorName) ? mirrorName : null
}

// ── Inventory primitives ────────────────────────────────────────

/** Distinct schemas present in the live catalog. Always lowercased. */
export function listSchemas(options: { accessor?: CatalogAccessor } = {}): string[] {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog) return []
  const out = new Set<string>()
  for (const [, t] of catalog.tables) out.add(t.schema.toLowerCase())
  return [...out].sort()
}

/** Top-N tables in the catalog sorted by rowCount (desc). Excludes nulls. */
export function topNTables(n: number, options: { accessor?: CatalogAccessor } = {}): CatalogTable[] {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog) return []
  const rows: CatalogTable[] = []
  for (const [, t] of catalog.tables) {
    if (t.type !== "TABLE") continue
    if (t.rowCount == null) continue
    rows.push(t)
  }
  rows.sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0))
  return rows.slice(0, n)
}

/** Top-N VIEWS by branch count (desc). Only views with branchCount ≥ 2. */
export function topNUnionViews(
  n: number,
  options: { accessor?: CatalogAccessor } = {}
): Array<{ table: CatalogTable; branchCount: number; sourceRows: number }> {
  const accessor = options.accessor ?? defaultCatalogAccessor
  const catalog = accessor()
  if (!catalog) return []
  const rows: Array<{ table: CatalogTable; branchCount: number; sourceRows: number }> = []
  for (const [, t] of catalog.tables) {
    if (t.type !== "VIEW") continue
    const bc = unionBranchCount(t.qualifiedName, { accessor })
    if (bc < 2) continue
    const sr = catalog.viewSourceRows.get(t.qualifiedName) ?? 0
    rows.push({ table: t, branchCount: bc, sourceRows: sr })
  }
  rows.sort((a, b) => b.branchCount - a.branchCount || b.sourceRows - a.sourceRows)
  return rows.slice(0, n)
}
