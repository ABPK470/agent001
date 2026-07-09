/**
 * Schema binding — enforce that query_mssql only touches tables and columns
 * grounded in the live catalog and per-run verification state.
 *
 * @module
 */

import type { CatalogAccessor } from "../catalog/index.js"

function stripForScan(query: string): string {
  return query
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'[^']*'/g, "''")
    .replace(/N'[^']*'/gi, "''")
}

/** Lowercased schema.table refs from FROM/JOIN (excludes #temp). */
export function extractBaseTableRefs(query: string): string[] {
  const stripped = stripForScan(query).replace(/\bWITH\s*\([^)]*\)/gi, (m) => " ".repeat(m.length))
  const out = new Set<string>()
  const re = /\b(?:FROM|JOIN)\s+\[?(\w+)\]?\.\[?(\w+)\]?(?:\s+(?:AS\s+)?\[?(\w+)\]?)?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const schema = m[1]!.toLowerCase()
    const table = m[2]!.toLowerCase()
    if (schema === "sys" || schema === "information_schema") continue
    out.add(`${schema}.${table}`)
  }
  return [...out]
}

/**
 * Tables referenced in SQL but not verified this run. When `verifiedTables`
 * is provided (including empty), every catalog-resolvable base table must
 * appear in the set before query_mssql runs.
 */
export function detectUnverifiedTableRefs(
  query: string,
  verifiedTables: ReadonlySet<string>,
  accessor: CatalogAccessor
): string[] {
  const catalog = accessor()
  if (!catalog) return []

  const missing: string[] = []
  for (const ref of extractBaseTableRefs(query)) {
    if (verifiedTables.has(ref)) continue
    if (!catalog.getTable(ref)) continue
    if (!missing.includes(ref)) missing.push(ref)
  }
  return missing
}

/** Split a statement on UNION / UNION ALL for per-branch column validation. */
export function splitUnionBranches(statement: string): string[] {
  const parts = statement.split(/\bUNION\s+ALL\b|\bUNION\b/i)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

/**
 * Illegal T-SQL: GROUP BY after the UNION chain at statement level
 * (each SELECT in a UNION must carry its own GROUP BY).
 */
export function detectPostUnionGroupBy(statement: string): boolean {
  const stripped = stripForScan(statement)
  if (!/\bUNION\b/i.test(stripped)) return false
  const branches = splitUnionBranches(stripped)
  if (branches.length < 2) return false
  const last = branches[branches.length - 1]!
  if (!/\bGROUP\s+BY\b/i.test(last)) return false
  for (let i = 0; i < branches.length - 1; i++) {
    if (/\bGROUP\s+BY\b/i.test(branches[i]!)) return false
  }
  return true
}

const BARE_SQL_KEYWORDS = new Set([
  "select",
  "from",
  "where",
  "join",
  "inner",
  "outer",
  "left",
  "right",
  "full",
  "cross",
  "on",
  "and",
  "or",
  "not",
  "as",
  "by",
  "group",
  "order",
  "having",
  "distinct",
  "top",
  "with",
  "union",
  "all",
  "case",
  "when",
  "then",
  "else",
  "end",
  "null",
  "is",
  "in",
  "exists",
  "between",
  "like",
  "over",
  "partition",
  "cast",
  "convert",
  "coalesce",
  "isnull",
  "sum",
  "count",
  "avg",
  "min",
  "max",
  "asc",
  "desc",
  "nolock"
])

export interface BareColumnOffender {
  readonly column: string
  readonly tables: readonly string[]
  readonly suggestions: readonly string[]
}

interface AliasBinding {
  alias: string
  qualifiedTable: string
}

interface CatalogColTable {
  columns: ReadonlyArray<{ name: string }>
}

/**
 * Bare identifiers in ON / WHERE and standalone SELECT items that do not
 * exist on any joined catalog table (e.g. `Name` when the column is `ClientName`).
 */
export function detectBareInventedColumns(
  statement: string,
  aliasMap: Map<string, AliasBinding>,
  getTable: (q: string) => CatalogColTable | null
): BareColumnOffender[] {
  if (aliasMap.size === 0) return []

  const tables = [...aliasMap.values()].map((b) => b.qualifiedTable)
  const colSets = tables.map((t) => {
    const tbl = getTable(t)
    return { table: t, cols: new Set((tbl?.columns ?? []).map((c) => c.name.toLowerCase())) }
  })

  const stripped = statement.replace(/\bWITH\s*\([^)]*\)/gi, (m) => " ".repeat(m.length))
  const clauses: string[] = []
  for (const m of stripped.matchAll(
    /\bON\s+([\s\S]*?)(?=\b(?:JOIN|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|UNION)\b|$)/gi
  )) {
    if (m[1]) clauses.push(m[1])
  }
  const where = /\bWHERE\b([\s\S]*?)(?=\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|UNION)\b|$)/i.exec(stripped)
  if (where?.[1]) clauses.push(where[1])

  const offenders: BareColumnOffender[] = []
  const seen = new Set<string>()

  for (const clause of clauses) {
    for (const m of clause.matchAll(/\b\[?([A-Za-z_][\w]*)\]?/g)) {
      const token = m[1]!
      const lower = token.toLowerCase()
      if (BARE_SQL_KEYWORDS.has(lower)) continue
      if (lower.length < 2) continue
      const after = clause.charAt(m.index! + m[0].length)
      if (after === "(") continue
      const before = clause.charAt(m.index! - 1)
      if (before === ".") continue
      if (seen.has(lower)) continue

      let foundOn = 0
      for (const { cols } of colSets) {
        if (cols.has(lower)) foundOn++
      }
      if (foundOn > 0) continue
      seen.add(lower)

      const allCols = colSets.flatMap(({ table }) => getTable(table)?.columns ?? [])
      offenders.push({ column: token, tables, suggestions: nearestBareColumns(token, allCols) })
    }
  }
  return offenders
}

function nearestBareColumns(target: string, columns: ReadonlyArray<{ name: string }>, k = 3): string[] {
  const t = target.toLowerCase()
  const scored = columns.map((c) => {
    const n = c.name.toLowerCase()
    let d = Math.max(n.length, t.length)
    if (n === t) d = -100
    else if (n.includes(t) || t.includes(n)) d = -50 + Math.abs(n.length - t.length)
    else {
      let prefix = 0
      while (prefix < Math.min(n.length, t.length) && n[prefix] === t[prefix]) prefix++
      d = Math.max(n.length, t.length) - prefix
    }
    return { name: c.name, d }
  })
  scored.sort((a, b) => a.d - b.d)
  const out: string[] = []
  for (const s of scored) {
    if (out.includes(s.name)) continue
    out.push(s.name)
    if (out.length >= k) break
  }
  return out
}
