import { tokenize } from "./helpers.js"
import type { CatalogSearchHit, CatalogTable, ConceptNode, ImplicitEdge } from "./types.js"

/**
 * Keyword search across table names and column names. Returns ranked results.
 *
 * Scoring factors:
 *   - Exact table-name token match: +100
 *   - Column-level matches: +10 per matched column
 *   - Schema tier boost: publish/persistedView highest, archive/etl negative
 *   - Structural signals: incoming FK references, column richness, implicit join connectivity
 *   - Concept-level matches: query tokens matching a concept name (+30 for view, +15 for tables)
 *   - Row count bonus (log scale, up to 20)
 */
export function searchCatalog(
  tables: Map<string, CatalogTable>,
  nameIndex: Map<string, Set<string>>,
  columnIndex: Map<string, Set<string>>,
  implicitJoinIndex: Map<string, ImplicitEdge[]>,
  conceptNodes: Map<string, ConceptNode>,
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

        const table = tables.get(key)!
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

  // Concept-level matches: query tokens matching a concept name pull in all tables
  // belonging to that concept, even those with no lexical match in name/columns.
  // e.g. search("revenue") → fact.CommissionAllocation gets conceptBonus=15 even
  // though neither "revenue" nor any variant appears in its name or column list.
  const conceptBonusMap = new Map<string, number>()
  for (const token of tokens) {
    const cNode = conceptNodes.get(token)
    if (cNode) {
      // Source view IS the concept — strongest signal
      if (!scores.has(cNode.sourceView)) scores.set(cNode.sourceView, { nameScore: 0, colMatches: [] })
      conceptBonusMap.set(cNode.sourceView, (conceptBonusMap.get(cNode.sourceView) ?? 0) + 30)
      // Contributing sources are semantically related to the concept
      for (const tk of cNode.tables) {
        if (!scores.has(tk)) scores.set(tk, { nameScore: 0, colMatches: [] })
        conceptBonusMap.set(tk, (conceptBonusMap.get(tk) ?? 0) + 15)
      }
    }
  }

  // Build ranked results
  const hits: CatalogSearchHit[] = []
  for (const [key, { nameScore, colMatches }] of scores) {
    const table = tables.get(key)!
    const colScore = colMatches.length * 10
    const rowBonus = table.rowCount ? Math.min(Math.log10(table.rowCount + 1) * 2, 20) : 0

    // Schema tier boost: publish/persistedView are the curated BI layer — rank them first
    const schema = table.schema.toLowerCase()
    const schemaBoost =
      schema === "publish" ? 50 :
      schema === "persistedview" ? 45 :
      (schema === "fact" || schema === "dim") ? 20 :
      schema === "list" ? 5 :
      (schema === "archive" || schema === "etl") ? -20 :
      0

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
