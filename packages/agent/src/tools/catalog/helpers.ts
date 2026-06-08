import type { CatalogTable, ImplicitEdge } from "./types.js"

// ── Tokenization ─────────────────────────────────────────────────

export function tokenize(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)
}

export function tableKey(schema: string, name: string): string {
  return `${schema}.${name}`
}

/** Is this column name likely a join candidate (ID, key, code, FK pattern)? */
export function isJoinCandidate(colName: string): boolean {
  const l = colName.toLowerCase()
  return (
    l.endsWith("id") ||
    l.endsWith("key") ||
    l.endsWith("code") ||
    l.endsWith("_fk") ||
    l.endsWith("_pk") ||
    l.includes("identifier") ||
    l.startsWith("fk") ||
    l.startsWith("pk")
  ) // catches pk_xxx, pkXxx, fk_xxx, fkXxx
}

/**
 * Compute implicit join edges: groups of tables sharing a join-candidate
 * column name with the same data type.  Skips columns appearing in 100+
 * tables (too generic).
 */
export function computeImplicitEdges(
  tables: Map<string, CatalogTable>,
  columnIndex: Map<string, Set<string>>
): ImplicitEdge[] {
  const edges: ImplicitEdge[] = []
  for (const [colName, tableKeys] of columnIndex) {
    if (tableKeys.size < 2 || tableKeys.size > 100) continue
    if (!isJoinCandidate(colName)) continue
    const byType = new Map<string, string[]>()
    for (const key of tableKeys) {
      const col = tables.get(key)?.columns.find((c) => c.name.toLowerCase() === colName)
      if (!col) continue
      const dt = col.dataType.toLowerCase()
      if (!byType.has(dt)) byType.set(dt, [])
      byType.get(dt)!.push(key)
    }
    for (const [dataType, group] of byType) {
      if (group.length >= 2) edges.push({ column: colName, dataType, tables: group })
    }
  }
  return edges
}

/**
 * Build name and column search indexes from a tables map.
 * Shared by CatalogGraph.build() and CatalogGraph.fromSnapshot().
 */
export function buildSearchIndexes(tables: Map<string, CatalogTable>): {
  nameIndex: Map<string, Set<string>>
  columnIndex: Map<string, Set<string>>
} {
  const nameIndex = new Map<string, Set<string>>()
  const columnIndex = new Map<string, Set<string>>()

  for (const [key, table] of tables) {
    // Index table/view name tokens
    for (const token of tokenize(table.name)) {
      if (!nameIndex.has(token)) nameIndex.set(token, new Set())
      nameIndex.get(token)!.add(key)
    }
    // Index schema name as token too
    const sToken = table.schema.toLowerCase()
    if (!nameIndex.has(sToken)) nameIndex.set(sToken, new Set())
    nameIndex.get(sToken)!.add(key)

    // Index column names
    for (const col of table.columns) {
      const colLower = col.name.toLowerCase()
      if (!columnIndex.has(colLower)) columnIndex.set(colLower, new Set())
      columnIndex.get(colLower)!.add(key)

      // Also index column name tokens into nameIndex (so "revenue" finds revenueAmount columns)
      for (const token of tokenize(col.name)) {
        if (!nameIndex.has(token)) nameIndex.set(token, new Set())
        nameIndex.get(token)!.add(key)
      }
    }
  }

  return { nameIndex, columnIndex }
}
