/**
 * Schema binding — enforce that query_mssql only touches tables and columns
 * grounded in the live catalog and per-run verification state.
 *
 * @module
 */

import type { CatalogAccessor } from "../../catalog/index.js"
import { verifiedTableKey } from "./schema-verified.js"

function isTableVerified(refLower: string, verifiedTables: ReadonlySet<string>): boolean {
  if (verifiedTables.has(refLower)) return true
  for (const v of verifiedTables) {
    if (verifiedTableKey(v) === refLower) return true
  }
  return false
}

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
    if (isTableVerified(ref, verifiedTables)) continue
    const catalogTable = catalog.getTable(ref)
    if (!catalogTable) continue
    const canonical = catalogTable.qualifiedName
    if (!missing.includes(canonical)) missing.push(canonical)
  }
  return missing
}

/** Split a statement on UNION / UNION ALL for per-branch column validation. */
export function splitUnionBranches(statement: string): string[] {
  const parts = statement.split(/\bUNION\s+ALL\b|\bUNION\b/i)
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

function stripTableHints(text: string): string {
  return text.replace(/\bWITH\s*\([^)]*\)/gi, (m) => " ".repeat(m.length))
}

/**
 * Blank out `(...)` regions so nested subqueries / EXISTS / IN (SELECT …)
 * do not contribute bare identifiers to the outer ON/WHERE invented-column
 * scan. Preserves length so match indices stay valid against the original.
 */
export function blankNestedParens(text: string): string {
  const out = text.split("")
  let depth = 0
  for (let i = 0; i < out.length; i++) {
    const ch = out[i]!
    if (ch === "(") {
      depth++
      out[i] = " "
      continue
    }
    if (ch === ")") {
      if (depth > 0) depth--
      out[i] = " "
      continue
    }
    if (depth > 0) out[i] = " "
  }
  return out.join("")
}

export interface CteDefinition {
  readonly name: string
  readonly body: string
}

export interface CteChain {
  readonly ctes: readonly CteDefinition[]
  readonly main: string
}

/** Split a SELECT list on top-level commas (paren-aware). */
export function splitSelectListItems(selectList: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < selectList.length; i++) {
    const c = selectList[i]!
    if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "," && depth === 0) {
      items.push(selectList.slice(start, i))
      start = i + 1
    }
  }
  items.push(selectList.slice(start))
  return items
}

/** Infer the output column name from one SELECT-list item. */
export function outputNameFromSelectItem(item: string): string | null {
  const trimmed = item.trim()
  if (!trimmed || trimmed === "*") return null

  const asMatch = /\bAS\s+\[?([A-Za-z_][\w]*)\]?\s*$/i.exec(trimmed)
  if (asMatch) return asMatch[1]!

  if (!/\(/.test(trimmed)) {
    const implicit = /\s+\[?([A-Za-z_][\w]*)\]?\s*$/.exec(trimmed)
    if (implicit) return implicit[1]!
  }

  const bracketed = /\[([A-Za-z_][\w]*)\]\s*$/.exec(trimmed)
  if (bracketed) return bracketed[1]!

  const dotted = /\.(?:\[?([A-Za-z_][\w]*)\]?)\s*$/.exec(trimmed)
  if (dotted) return dotted[1]!

  if (/^\[?([A-Za-z_][\w]*)\]?$/.test(trimmed)) return trimmed.replace(/[[\]]/g, "")
  return null
}

/** Top-level SELECT … FROM span (paren-aware) — nested FROM inside subqueries is ignored. */
export function extractTopLevelSelectList(body: string): string | null {
  const stripped = stripTableHints(stripForScan(body))
  const selectRe = /\bSELECT\s+(?:DISTINCT\s+)?(?:TOP\s+(?:\(\s*\d+\s*\)|\d+)\s+(?:PERCENT\s+)?)?/i
  const selectMatch = selectRe.exec(stripped)
  if (!selectMatch) return null
  const listStart = selectMatch.index + selectMatch[0].length
  let depth = 0
  for (let i = listStart; i < stripped.length; i++) {
    const ch = stripped[i]!
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0 && /\s/.test(ch)) {
      const tail = stripped.slice(i)
      const fromAt = /^\s+FROM\b/i.exec(tail)
      if (fromAt) return stripped.slice(listStart, i + fromAt.index).trim()
    }
  }
  return null
}

/** Output column names exposed by a CTE/subquery SELECT body. */
export function extractCteOutputColumns(body: string): ReadonlySet<string> {
  const selectList = extractTopLevelSelectList(body)
  if (!selectList) return new Set()

  const cols = new Set<string>()
  for (const item of splitSelectListItems(selectList)) {
    const name = outputNameFromSelectItem(item)
    if (name) cols.add(name.toLowerCase())
  }
  return cols
}

/**
 * Parse `WITH cte AS (...), ... SELECT ...` into CTE bodies and the main query.
 * Returns null when the statement is not CTE-shaped.
 */
export function parseCteChain(statement: string): CteChain | null {
  const stripped = stripTableHints(stripForScan(statement))
  const withHead = /^\s*WITH\s+/i.exec(stripped)
  if (!withHead) return null

  const ctes: CteDefinition[] = []
  let pos = withHead[0].length

  while (pos < stripped.length) {
    const tail = stripped.slice(pos)
    const nameMatch = /^\s*(\w+)\s+AS\s*\(/i.exec(tail)
    if (!nameMatch) break

    const name = nameMatch[1]!
    pos += nameMatch[0].length - 1

    let depth = 1
    const bodyStart = pos + 1
    pos++
    while (pos < stripped.length && depth > 0) {
      const c = stripped[pos]!
      if (c === "(") depth++
      else if (c === ")") depth--
      pos++
    }
    if (depth !== 0) break

    ctes.push({ name, body: stripped.slice(bodyStart, pos - 1) })

    const after = stripped.slice(pos).trimStart()
    if (after.startsWith(",")) {
      pos = stripped.length - after.length + 1
      continue
    }
    break
  }

  const main = stripped.slice(pos).trim()
  if (ctes.length === 0 || !main) return null
  return { ctes, main }
}

/** Map CTE names and their FROM aliases to the columns each exposes. */
export function buildCteBindings(ctes: readonly CteDefinition[]): Map<string, ReadonlySet<string>> {
  const bindings = new Map<string, ReadonlySet<string>>()
  for (const cte of ctes) {
    extendCteFromAliases(cte.body, bindings)
    bindings.set(cte.name.toLowerCase(), extractCteOutputColumns(cte.body))
  }
  return bindings
}

/** Register `FROM cte alias` / `JOIN cte alias` aliases against known CTE outputs. */
export function extendCteFromAliases(
  fragment: string,
  bindings: Map<string, ReadonlySet<string>>
): void {
  const stripped = stripTableHints(stripForScan(fragment))
  const re =
    /\b(?:FROM|JOIN)\s+(?:\[?(\w+)\]?\.\[?(\w+)\]?(?:\s+(?:AS\s+)?\[?(\w+)\]?)?|\[?(\w+)\]?(?:\s+(?:AS\s+)?\[?(\w+)\]?)?)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    if (m[1] && m[2]) continue

    const cteName = m[4]!.toLowerCase()
    const cols = bindings.get(cteName)
    if (!cols) continue

    const aliasRaw = m[5]
    const alias = aliasRaw && aliasRaw.toLowerCase() !== cteName ? aliasRaw.toLowerCase() : cteName
    bindings.set(alias, cols)
  }
}

export function unionCteOutputColumns(bindings: Map<string, ReadonlySet<string>>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const cols of bindings.values()) {
    for (const col of cols) out.add(col)
  }
  return out
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

export interface BareColumnCheckOptions {
  /** Column names projected by in-scope CTEs (may appear bare in ON/WHERE). */
  readonly allowedBareColumns?: ReadonlySet<string>
}

/**
 * Bare identifiers in ON / WHERE that do not exist on any joined catalog table
 * or in-scope CTE projection (e.g. `Name` when the column is `ClientName`, or
 * a CTE alias like `ranked` in `ranked.rn` must not be treated as a column).
 */
export function detectBareInventedColumns(
  statement: string,
  aliasMap: Map<string, AliasBinding>,
  getTable: (q: string) => CatalogColTable | null,
  options: BareColumnCheckOptions = {}
): BareColumnOffender[] {
  const allowedBare = options.allowedBareColumns ?? new Set<string>()
  if (aliasMap.size === 0 && allowedBare.size === 0) return []

  const tables = [...aliasMap.values()].map((b) => b.qualifiedTable)
  const colSets = tables.map((t) => {
    const tbl = getTable(t)
    return { table: t, cols: new Set((tbl?.columns ?? []).map((c) => c.name.toLowerCase())) }
  })

  const stripped = blankNestedParens(stripTableHints(statement))
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
      if (after === "(" || after === ".") continue
      const before = clause.charAt(m.index! - 1)
      if (before === ".") continue
      if (seen.has(lower)) continue
      if (allowedBare.has(lower)) continue

      let foundOn = 0
      for (const { cols } of colSets) {
        if (cols.has(lower)) foundOn++
      }
      if (foundOn > 0) continue
      if (aliasMap.size === 0) continue
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
