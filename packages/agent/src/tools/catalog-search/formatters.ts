import type { CatalogFK, CatalogTable, SysEntry } from "../catalog/index.js"

// ── Formatters ───────────────────────────────────────────────────

export function fmtRow(n: number | null): string {
  if (n == null) return ""
  if (n >= 1e9) return `~${(n / 1e9).toFixed(1)}B rows`
  if (n >= 1e6) return `~${(n / 1e6).toFixed(0)}M rows`
  if (n >= 1e3) return `~${(n / 1e3).toFixed(0)}K rows`
  return `${n} rows`
}

export function fmtTable(
  t: CatalogTable | undefined | null,
  matchedCols?: string[],
  catalog?: {
    getImplicitJoins(key: string, limit?: number): { column: string; dataType: string; tables: string[] }[]
  },
): string {
  if (!t) return "(unknown table)"
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

  // Column names: PKs first, then all non-PK — show enough to judge the table's content.
  // Cap raised from 15 to 40 because hallucinated column names (e.g. inventing
  // `VolumeUSDMTD` when only `VolumeMTD` exists) were directly caused by the model
  // not seeing the real currency/period variants hidden behind "(+N more)". 40 covers
  // every typical curated fact/dim in this warehouse; the very wide audit views
  // (>40 cols) still truncate, but those rarely participate in metric SELECTs.
  const COLUMN_DISPLAY_CAP = 40
  const pks = t.columns.filter((c) => c.isPK)
  const nonPk = t.columns.filter((c) => !c.isPK)
  const shown = [...pks, ...nonPk].slice(0, COLUMN_DISPLAY_CAP)
  const colStr = shown.map((c) => {
    const flags: string[] = []
    if (c.isPK) flags.push("PK")
    return `${c.name}${flags.length ? " (" + flags.join(", ") + ")" : ""}`
  }).join(", ")
  lines.push(`    Columns: ${colStr}${colCount > COLUMN_DISPLAY_CAP ? ` (+${colCount - COLUMN_DISPLAY_CAP} more)` : ""}`)

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

  return lines.join("\n")
}

export function fmtPath(path: CatalogFK[]): string {
  return path.map((fk) =>
    `  ${fk.fromSchema}.${fk.fromTable}.${fk.fromColumn} → ${fk.toSchema}.${fk.toTable}.${fk.toColumn}`,
  ).join("\n")
}

/**
 * Format a sys catalog entry for display in search results or sys lookup mode.
 * Clearly marks it as a sys object to guide the agent to use query_mssql directly.
 */
export function fmtSysEntry(entry: SysEntry): string {
  const lines: string[] = []
  lines.push(`  [SYS] ${entry.qualifiedName}`)
  if (entry.columns.length > 0) {
    // Match fmtTable cap so the model sees the real surface of a sys.* view
    // instead of guessing a column name that fell off the end at 15.
    const SYS_COLUMN_DISPLAY_CAP = 40
    const shown = entry.columns.slice(0, SYS_COLUMN_DISPLAY_CAP)
    const colStr = shown.map((c) => `${c.name} (${c.dataType})`).join(", ")
    lines.push(`    Columns: ${colStr}${entry.columns.length > SYS_COLUMN_DISPLAY_CAP ? ` (+${entry.columns.length - SYS_COLUMN_DISPLAY_CAP} more)` : ""}`)
  }
  lines.push(`    ⇒ Query with: query_mssql({ query: "SELECT ... FROM ${entry.qualifiedName} ..." })`)
  return lines.join("\n")
}
