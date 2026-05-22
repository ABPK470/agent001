import { getTenantConfig } from "../../tenant/config.js"
import { tokenize } from "./helpers.js"
import type { CatalogSearchHit, CatalogTable, ImplicitEdge } from "./types.js"

/**
 * Keyword search across table names and column names. Returns ranked results.
 *
 * Scoring factors:
 *   - Exact table-name token match: +100
 *   - Column-level matches: +10 per matched column
 *   - Schema tier boost: publish/persistedView highest, archive/etl negative
 *   - Structural signals: incoming FK references, column richness, implicit join connectivity
 *   - Row count bonus (log scale, up to 20)
 */
export function searchCatalog(
  tables: Map<string, CatalogTable>,
  nameIndex: Map<string, Set<string>>,
  columnIndex: Map<string, Set<string>>,
  implicitJoinIndex: Map<string, ImplicitEdge[]>,
  query: string,
  limit: number,
): CatalogSearchHit[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []

  // Score each table
  const scores = new Map<string, { nameScore: number; colMatches: string[] }>()

  for (const token of tokens) {
    // Name-level matches (table name or schema name contains token)
    const nameHits = nameIndex.get(token)
    if (nameHits) {
      for (const key of nameHits) {
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

  // Build ranked results
  const hits: CatalogSearchHit[] = []
  for (const [key, { nameScore, colMatches }] of scores) {
    const table = tables.get(key)
    if (!table) continue  // concept-graph key may reference a table not in the catalog
    const colScore = colMatches.length * 10
    const rowBonus = table.rowCount ? Math.min(Math.log10(table.rowCount + 1) * 2, 20) : 0

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

    const score = nameScore + colScore + rowBonus + schemaBoost + viewBonus +
      incomingFkBonus + colRichness + connectivityBonus + conceptBonus

    hits.push({
      table,
      matchType: nameScore > 0 ? "name" : "column",
      matchedColumns: colMatches,
      score,
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
