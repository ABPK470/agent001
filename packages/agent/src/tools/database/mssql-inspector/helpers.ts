// ── Duplicate join detection ─────────────────────────────────────

/**
 * Parse a T-SQL definition and find table/view references in FROM/JOIN clauses.
 * Returns a map of qualified-name → occurrence count.
 */
export function parseTSqlReferences(definition: string): Map<string, number> {
  // Normalize: collapse whitespace, strip comments
  const cleaned = definition
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/\s+/g, " ")
    .toUpperCase()

  const counts = new Map<string, number>()

  // Match FROM / JOIN patterns: FROM schema.table or JOIN schema.table [AS alias]
  // Also handles [schema].[table] bracket quoting and bare table names
  const ref = /(?:FROM|JOIN)\s+(?:\[?(\w+)\]?\.\[?(\w+)\]?|\[?(\w+)\]?)(?:\s+(?:AS\s+)?\[?\w+\]?)?/g
  let m: RegExpExecArray | null
  while ((m = ref.exec(cleaned)) !== null) {
    let key: string
    if (m[1] && m[2]) {
      key = `${m[1]}.${m[2]}`
    } else if (m[3]) {
      // Bare name — no schema prefix
      key = m[3]
    } else continue

    // Skip SQL Server system aliases that look like table refs
    if (/^(INNER|LEFT|RIGHT|FULL|OUTER|CROSS|LATERAL)$/.test(key)) continue

    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return counts
}

export function formatDuplicates(counts: Map<string, number>): string {
  const dupes = [...counts.entries()].filter(([, n]) => n > 1)
  if (dupes.length === 0) return "No duplicate table references found."
  return (
    `DUPLICATE JOIN REFERENCES DETECTED (${dupes.length}):\n` +
    dupes.map(([name, n]) => `  ${name} — referenced ${n} times`).join("\n") +
    "\n\nThese are likely candidates for join redundancy. " +
    "Removing duplicate joins can significantly reduce execution time on large tables."
  )
}
