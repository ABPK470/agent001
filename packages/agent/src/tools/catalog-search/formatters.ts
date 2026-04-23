import type { CatalogFK, CatalogTable, SysEntry, ViewLineage } from "../catalog.js"

// ── Formatters ───────────────────────────────────────────────────

export function fmtRow(n: number | null): string {
  if (n == null) return ""
  if (n >= 1e9) return `~${(n / 1e9).toFixed(1)}B rows`
  if (n >= 1e6) return `~${(n / 1e6).toFixed(0)}M rows`
  if (n >= 1e3) return `~${(n / 1e3).toFixed(0)}K rows`
  return `${n} rows`
}

export function fmtTable(
  t: CatalogTable,
  matchedCols?: string[],
  catalog?: {
    getImplicitJoins(key: string, limit?: number): { column: string; dataType: string; tables: string[] }[]
    getTableConcepts(key: string): { concept: string; sourceView: string }[]
  },
): string {
  const lines: string[] = []
  const rowInfo = fmtRow(t.rowCount)

  // Header: name, type, size
  const colCount = t.columns.length
  const fkOut = t.fkOutgoing.length
  const fkIn = t.fkIncoming.length
  const implicitCount = catalog ? catalog.getImplicitJoins(t.qualifiedName).length : 0
  const connectivity = fkOut + fkIn + implicitCount

  const badges: string[] = [t.type]
  if (rowInfo) badges.push(rowInfo)
  badges.push(`${colCount} cols`)
  if (connectivity > 0) badges.push(`${connectivity} joins`)
  if (fkIn > 5) badges.push(`★ central (${fkIn} tables reference this)`)

  lines.push(`  ${t.qualifiedName} (${badges.join(", ")})`)

  // Column names: PKs first, then all non-PK — show enough to judge the table's content
  const pks = t.columns.filter((c) => c.isPK)
  const nonPk = t.columns.filter((c) => !c.isPK)
  const shown = [...pks, ...nonPk].slice(0, 15)
  const colStr = shown.map((c) => {
    const flags: string[] = []
    if (c.isPK) flags.push("PK")
    return `${c.name}${flags.length ? " (" + flags.join(", ") + ")" : ""}`
  }).join(", ")
  lines.push(`    Columns: ${colStr}${colCount > 15 ? ` (+${colCount - 15} more)` : ""}`)

  // Highlight matched columns if any
  if (matchedCols && matchedCols.length > 0) {
    lines.push(`    Matched: ${matchedCols.join(", ")}`)
  }

  // FK relationships — show what this table connects to
  if (fkOut > 0) {
    const dims = t.fkOutgoing.slice(0, 6).map((fk) => `${fk.toSchema}.${fk.toTable}`)
    const unique = [...new Set(dims)]
    lines.push(`    References: ${unique.join(", ")}${fkOut > 6 ? ` (+${fkOut - 6} more)` : ""}`)
  }
  if (fkIn > 0) {
    lines.push(`    Referenced by: ${fkIn} other tables`)
  }

  // Business concepts — semantic context derived from lineage; reveals relationships beyond FK structure
  const concepts = catalog?.getTableConcepts(t.qualifiedName) ?? []
  if (concepts.length > 0) {
    lines.push(`    Concepts: ${concepts.map((c) => `${c.concept} (via ${c.sourceView})`).join(", ")}`)
  }

  return lines.join("\n")
}

export function fmtPath(path: CatalogFK[]): string {
  return path.map((fk) =>
    `  ${fk.fromSchema}.${fk.fromTable}.${fk.fromColumn} → ${fk.toSchema}.${fk.toTable}.${fk.toColumn}`,
  ).join("\n")
}

export function fmtLineage(l: ViewLineage): string {
  const lines = [
    `LINEAGE MAP: ${l.view}`,
    l.description,
    "",
    `Output columns (${l.outputColumns.length}): ${l.outputColumns.join(", ")}`,
    "",
    `Dimension Joins (${l.dimJoins.length}):`,
  ]
  for (const d of l.dimJoins) {
    lines.push(`  ${d.column} → ${d.dimTable} (${d.dimRows}) — ${d.note}`)
  }

  // Group sources by business group
  const groups = new Map<string, typeof l.sources>()
  for (const s of l.sources) {
    if (!groups.has(s.group)) groups.set(s.group, [])
    groups.get(s.group)!.push(s)
  }

  lines.push("", `Sources (${l.sources.length} total):`)
  for (const [group, sources] of groups) {
    lines.push(``, `  ▸ ${group} (${sources.length}):`)
    for (const s of sources) {
      lines.push(`    ${s.qualifiedName} — ${s.businessArea}`)
      if (s.filter && s.filter !== "all rows") lines.push(`      filter: ${s.filter}`)
    }
  }

  lines.push(
    "",
    "To drill deeper into any source: inspect_definition(object='MappingName', schema='publish')",
    "To query this view: always filter by pkMonth + pkClient (both are high-cardinality).",
  )
  return lines.join("\n")
}

/**
 * Format a sys catalog entry for display in search results or sys lookup mode.
 * Clearly marks it as a sys object to guide the agent to use query_mssql directly.
 */
export function fmtSysEntry(entry: SysEntry): string {
  const lines: string[] = []
  lines.push(`  [SYS] ${entry.qualifiedName}`)
  if (entry.columns.length > 0) {
    const shown = entry.columns.slice(0, 15)
    const colStr = shown.map((c) => `${c.name} (${c.dataType})`).join(", ")
    lines.push(`    Columns: ${colStr}${entry.columns.length > 15 ? ` (+${entry.columns.length - 15} more)` : ""}`)
  }
  lines.push(`    ⇒ Query with: query_mssql({ query: "SELECT ... FROM ${entry.qualifiedName} ..." })`)
  return lines.join("\n")
}
