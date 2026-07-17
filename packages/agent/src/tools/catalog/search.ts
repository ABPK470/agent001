import type { TableVerdictsReader } from "../../runtime/runtime.js"
import { getTenantConfig } from "../../domain/tenant/tenant-config.js"
import { defaultSchemaRolePenalty, classifySchemaRole, rowCountBonusForSchema } from "./schema-role.js"
import { tokenize } from "./helpers.js"
import type { CatalogSearchHit, CatalogTable, ImplicitEdge } from "./types.js"

export interface SearchCatalogOptions {
  viewSourceRows?: Map<string, number>
  tableVerdicts?: TableVerdictsReader | null
  /** Scope ranking to one schema — applied during scoring, not after top-N. */
  schemaFilter?: string
}

/**
 * Keyword search across table names and column names. Returns ranked results.
 *
 * Scoring factors:
 *   - Exact table-name token match: +100
 *   - Column-level matches: +10 per matched column
 *   - Schema tier boost: publish/persistedView highest, archive/etl negative
 *   - Structural signals: incoming FK references, column richness, implicit join connectivity
 *   - Row count bonus (log scale, up to 20)
 *
 * First-principles signals (Plan v3 Phase 1) — derived purely from
 * catalog data; no per-tenant curation:
 *   - VIEW fan-in: `log10(viewSourceRows + 1) × 8` capped at 40. A wide
 *     UNION view (e.g. 59-branch revenue aggregator) dominates 1-branch
 *     rule subsets that share the same name root.
 *   - Subset-of-candidate: if candidate X's `viewDefinition` references
 *     candidate Y (`FROM schema.Y` / `JOIN schema.Y`), Y is structurally
 *     more canonical → Y +30, X −40.
 *   - Name-cluster bareness: among ≥2 candidates sharing a name prefix,
 *     the bare token (e.g. `Revenue` among `Revenue|RevenueESGRules|
 *     RevenueRWARules`) gets +25.
 */
export function searchCatalog(
  tables: Map<string, CatalogTable>,
  nameIndex: Map<string, Set<string>>,
  columnIndex: Map<string, Set<string>>,
  implicitJoinIndex: Map<string, ImplicitEdge[]>,
  query: string,
  limit: number,
  options: SearchCatalogOptions = {}
): CatalogSearchHit[] {
  const { viewSourceRows, tableVerdicts, schemaFilter } = options
  const schemaLc = schemaFilter?.toLowerCase()
  const tableInScope = (key: string): boolean => {
    if (!schemaLc) return true
    const table = tables.get(key)
    return table ? table.schema.toLowerCase() === schemaLc : false
  }

  const tokens = tokenize(query)
  if (tokens.length === 0) return []

  // Score each table
  const scores = new Map<string, { nameScore: number; colMatches: string[] }>()

  for (const token of tokens) {
    // Name-level matches (table name or schema name contains token)
    const nameHits = nameIndex.get(token)
    if (nameHits) {
      for (const key of nameHits) {
        if (!tableInScope(key)) continue
        if (!scores.has(key)) scores.set(key, { nameScore: 0, colMatches: [] })
        const entry = scores.get(key)!

        const table = tables.get(key)
        if (!table) continue
        // Exact table-name token match scores highest
        const tableTokens = tokenize(table.name)
        if (tableTokens.includes(token)) {
          entry.nameScore += 100
        }
      }
    }
  }

  // Column-level matches: find tables with columns matching any query token
  for (const token of tokens) {
    for (const [colName, tableKeys] of columnIndex) {
      if (colName.includes(token) || tokenize(colName).includes(token)) {
        for (const key of tableKeys) {
          if (!tableInScope(key)) continue
          if (!scores.has(key)) scores.set(key, { nameScore: 0, colMatches: [] })
          const entry = scores.get(key)!
          if (!entry.colMatches.includes(colName)) {
            entry.colMatches.push(colName)
          }
        }
      }
    }
  }

  // Concept-level matches removed with lineage subsystem. Per-token
  // semantic bonuses (sourceView, contributing tables) are no longer
  // applied; lexical scoring + structural signals carry ranking.
  const conceptBonusMap = new Map<string, number>()

  // ── Cross-candidate structural signals (Plan v3 Phase 1) ──────
  //
  // Computed once per call across the candidate set so they are O(N²)
  // in candidate count (not catalog size). Cheap because N ≤ a few
  // dozen for any realistic query.
  const candidateKeys = [...scores.keys()].filter((k) => tables.has(k))
  const subsetBonus = computeSubsetOfCandidateSignals(candidateKeys, tables)
  const nameClusterBonus = computeNameClusterBareBonus(candidateKeys, tables)
  // Memory verdicts (Plan v3 Phase 4): consult prior runs' role
  // classifications via the runtime callback. Silent no-op when unbound
  // (CLI, tests) or when no verdicts exist — purely additive signal.
  const verdictBonus = computeMemoryVerdictBonus(candidateKeys, tables, tableVerdicts)

  // Build ranked results
  const hits: CatalogSearchHit[] = []
  for (const [key, { nameScore, colMatches }] of scores) {
    const table = tables.get(key)
    if (!table) continue // concept-graph key may reference a table not in the catalog
    const colScore = colMatches.length * 10
    const rowBonus = rowCountBonusForSchema(table.schema, table.rowCount)

    // Schema tier boost: per-deployment ranking lives in tenant config
    // (`schemaRanking`). When unset, no per-schema bias is applied — search
    // ranks purely on shape (rowCount, fanout, column richness, …).
    const schemaBoost = schemaWeightFor(table.schema)

    // Structural signals — tables that are MORE connected/richer are more likely correct
    const viewBonus = table.type === "VIEW" ? 10 : 0
    // Centrality: tables referenced by many others are important (dimension tables, key publish views)
    const incomingFkBonus = Math.min(table.fkIncoming.length * 3, 30)
    // Column richness: tables with more columns have more data — more useful for analysis
    const colRichness = Math.min(Math.floor(table.columns.length / 5) * 2, 20)
    // Implicit join connectivity: tables with many implicit joins are well-connected
    const implicitJoins = implicitJoinIndex.get(key)?.length ?? 0
    const connectivityBonus = Math.min(implicitJoins * 2, 16)
    // Semantic boost: table belongs to a concept matching the query
    const conceptBonus = conceptBonusMap.get(key) ?? 0

    // ── First-principles signals (Plan v3 Phase 1) ────────────────
    // Fan-in: VIEWs aggregating many source-table rows are canonical.
    const fanInRows = viewSourceRows?.get(table.qualifiedName) ?? 0
    const fanInBonus = fanInRows > 0 ? Math.min(Math.log10(fanInRows + 1) * 8, 40) : 0
    // Subset-of-candidate: parent +30, branch −40 (relative to other candidates only).
    const subsetSignal = subsetBonus.get(key) ?? 0
    // Bare-name preference among siblings sharing a prefix.
    const nameClusterSignal = nameClusterBonus.get(key) ?? 0
    // Memory verdict bonus: durable role classification from prior runs.
    const memorySignal = verdictBonus.get(key) ?? 0

    const score =
      nameScore +
      colScore +
      rowBonus +
      schemaBoost +
      viewBonus +
      incomingFkBonus +
      colRichness +
      connectivityBonus +
      conceptBonus +
      fanInBonus +
      subsetSignal +
      nameClusterSignal +
      memorySignal

    hits.push({
      table,
      matchType: nameScore > 0 ? "name" : "column",
      matchedColumns: colMatches,
      score
    })
  }

  // Sort: highest score first, then by row count descending
  hits.sort((a, b) => b.score - a.score || (b.table.rowCount ?? 0) - (a.table.rowCount ?? 0))
  return hits.slice(0, limit)
}

/**
 * Resolve the schema-ranking weight from tenant config. Supports BOTH
 * supported shapes:
 *   - canonical: `ReadonlyArray<{ schema: string; weight: number }>`
 *   - legacy object: `Record<string, number>` (kept for back-compat with
 *     existing test fixtures and per-deployment JSON shorthand).
 * Lookup is case-insensitive. Returns 0 when no match.
 */
function schemaWeightFor(schema: string): number {
  const tenantWeight = schemaWeightFromTenant(schema)
  return tenantWeight + defaultSchemaRolePenalty(classifySchemaRole(schema))
}

function schemaWeightFromTenant(schema: string): number {
  const ranking = getTenantConfig().schemaRanking as
    | ReadonlyArray<{ schema: string; weight: number }>
    | Record<string, number>
    | undefined
  if (!ranking) return 0
  const target = schema.toLowerCase()
  if (Array.isArray(ranking)) {
    for (const entry of ranking) {
      if (entry?.schema?.toLowerCase() === target) return entry.weight ?? 0
    }
    return 0
  }
  for (const k of Object.keys(ranking)) {
    if (k.toLowerCase() === target) return (ranking as Record<string, number>)[k] ?? 0
  }
  return 0
}

// ── First-principles cross-candidate signals (Plan v3 Phase 1) ─────

/**
 * For every candidate VIEW, scan its `viewDefinition` for references to
 * OTHER candidates' qualified names. If candidate X's definition contains
 * candidate Y, X is a parent/aggregator and Y is one of its branches:
 *   - X (parent) → +30
 *   - Y (branch) → −40
 *
 * Detection is deliberately conservative: matches `FROM <schema>.<name>`
 * and `JOIN <schema>.<name>` (case-insensitive, word-bounded). Misses
 * exotic forms (CTEs, dynamic SQL) but never false-positives on prose
 * comments because the FROM/JOIN keyword anchors the match.
 *
 * Returns a sparse map: only candidates with a non-zero signal appear.
 */
function computeSubsetOfCandidateSignals(
  candidateKeys: string[],
  tables: Map<string, CatalogTable>
): Map<string, number> {
  const bonus = new Map<string, number>()
  if (candidateKeys.length < 2) return bonus

  // Pre-build qname → key map (qnames may differ in case from keys).
  const qnameToKey = new Map<string, string>()
  for (const k of candidateKeys) {
    const t = tables.get(k)
    if (t) qnameToKey.set(t.qualifiedName.toLowerCase(), k)
  }

  for (const parentKey of candidateKeys) {
    const parent = tables.get(parentKey)
    if (!parent || parent.type !== "VIEW" || !parent.viewDefinition) continue
    const def = parent.viewDefinition.toLowerCase()
    for (const [branchQname, branchKey] of qnameToKey) {
      if (branchKey === parentKey) continue
      // Word-bounded FROM/JOIN reference. Escape dot in qname.
      const escaped = branchQname.replace(/[.[\]]/g, (ch) => "\\" + ch)
      const pattern = new RegExp(`(?:from|join)\\s+${escaped}\\b`, "i")
      if (pattern.test(def)) {
        bonus.set(parentKey, (bonus.get(parentKey) ?? 0) + 30)
        bonus.set(branchKey, (bonus.get(branchKey) ?? 0) - 40)
      }
    }
  }
  return bonus
}

/**
 * Among candidates whose table names share a non-trivial prefix (the
 * "name cluster"), boost the candidate whose name IS the bare prefix.
 *
 * Heuristic: group candidates by the longest common-prefix table-name
 * token (case-insensitive). Within each group of ≥2, the candidate
 * whose `name` (case-insensitive) equals the group's bare token
 * receives +25. Suffixed siblings (e.g. `RevenueESGRules` next to
 * `Revenue`) are unaffected — this is a positive-only signal.
 *
 * Returns a sparse map: only awarded candidates appear.
 */
function computeNameClusterBareBonus(
  candidateKeys: string[],
  tables: Map<string, CatalogTable>
): Map<string, number> {
  const bonus = new Map<string, number>()
  if (candidateKeys.length < 2) return bonus

  // Group by bare prefix: the candidate's lowercase name is a prefix
  // of OR equal to another candidate's lowercase name. Find groups
  // anchored on each candidate's bare name.
  const lcName = (k: string): string | null => {
    const t = tables.get(k)
    return t ? t.name.toLowerCase() : null
  }

  for (const bareKey of candidateKeys) {
    const bare = lcName(bareKey)
    if (!bare || bare.length < 4) continue // ignore trivial 1-3 char prefixes
    let hasSuffixedSibling = false
    for (const otherKey of candidateKeys) {
      if (otherKey === bareKey) continue
      const other = lcName(otherKey)
      if (!other) continue
      if (other.startsWith(bare) && other.length > bare.length) {
        hasSuffixedSibling = true
        break
      }
    }
    if (hasSuffixedSibling) {
      bonus.set(bareKey, (bonus.get(bareKey) ?? 0) + 25)
    }
  }
  return bonus
}

/**
 * Memory-verdict bonus (Plan v3 Phase 4): consult the durable
 * `table_verdict` records stored in semantic memory and bias ranking
 * toward objects prior runs classified as canonical, against those
 * classified as subsets / rules / archives / staging.
 *
 * Magnitudes (calibrated to dominate within-cluster sibling noise but
 * stay subordinate to user-explicit qname mentions):
 *   canonical → +200
 *   subset    → −150
 *   rules     → −120
 *   staging   →  −80
 *   archive   →  −60
 *   unknown   →    0   (informational only)
 *
 * Robust to:
 *   - No runtime binding (CLI, tests): callback null → no-op
 *   - Lookup throws: swallow → no-op (purely additive; never blocks)
 *   - Empty candidates: short-circuit
 *
 * Returns a sparse map: only candidates with non-zero verdict appear.
 */
function computeMemoryVerdictBonus(
  candidateKeys: string[],
  tables: Map<string, CatalogTable>,
  tableVerdicts?: TableVerdictsReader | null
): Map<string, number> {
  const bonus = new Map<string, number>()
  if (candidateKeys.length === 0) return bonus

  const list = tableVerdicts?.list ?? null
  if (!list) return bonus

  // Map qname → key (preserve case for qname lookups; server matches
  // case-insensitively but we need the key back to apply bonus).
  const qnameToKey = new Map<string, string>()
  const qnames: string[] = []
  for (const k of candidateKeys) {
    const t = tables.get(k)
    if (!t) continue
    qnameToKey.set(t.qualifiedName.toLowerCase(), k)
    qnames.push(t.qualifiedName)
  }

  let verdicts: ReturnType<TableVerdictsReader["list"]> = []
  try {
    verdicts = list({ qnames })
  } catch {
    return bonus
  }

  for (const v of verdicts) {
    const key = qnameToKey.get(v.qname.toLowerCase())
    if (!key) continue
    const delta = verdictBonusForRole(v.role)
    if (delta !== 0) bonus.set(key, (bonus.get(key) ?? 0) + delta)
  }
  return bonus
}

function verdictBonusForRole(role: string): number {
  switch (role) {
    case "canonical":
      return +200
    case "subset":
      return -150
    case "rules":
      return -120
    case "staging":
      return -80
    case "archive":
      return -60
    default:
      return 0
  }
}
