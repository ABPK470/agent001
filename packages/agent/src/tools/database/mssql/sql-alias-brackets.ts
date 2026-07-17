/**
 * MSSQL table-alias bracket convention.
 *
 * Every table alias MUST be declared and referenced with T-SQL bracket
 * identifiers so reserved words (e.g. `off`, `on`, `as`) never corrupt parsing:
 *
 *   FROM dim.Officer AS [off]
 *   INNER JOIN publish.Revenue AS [r] ON [r].[pkOfficer] = [off].[pkOfficer]
 *   WITH [off] AS (…) SELECT [off].[n] FROM [off]
 *   SELECT [off].[OfficerName] …
 */

/** Tokens that must never be bare table aliases (T-SQL reserved + common traps). */
export const ALIAS_MUST_BRACKET = new Set(
  [
    "off",
    "on",
    "as",
    "in",
    "or",
    "and",
    "not",
    "by",
    "to",
    "from",
    "join",
    "inner",
    "outer",
    "left",
    "right",
    "full",
    "cross",
    "apply",
    "where",
    "group",
    "order",
    "having",
    "select",
    "with",
    "union",
    "all",
    "any",
    "some",
    "case",
    "when",
    "then",
    "else",
    "end",
    "over",
    "partition",
    "rows",
    "range",
    "row",
    "current",
    "user",
    "key",
    "index",
    "option",
    "set",
    "top",
    "distinct",
    "null",
    "is",
    "between",
    "exists",
    "into",
    "values",
    "open",
    "close",
    "begin",
    "commit",
    "rollback",
    "use",
    "go"
  ].map((s) => s.toLowerCase())
)

const IDENT = String.raw`[A-Za-z_][\w$#]*`

/** Cannot be an implicit (non-AS) table alias — starts the next clause. */
const IMPLICIT_ALIAS_BLOCKLIST = new Set(
  [
    "on",
    "where",
    "group",
    "order",
    "having",
    "union",
    "except",
    "intersect",
    "join",
    "inner",
    "left",
    "right",
    "full",
    "cross",
    "outer",
    "apply",
    "set",
    "pivot",
    "unpivot",
    "for",
    "window",
    "fetch",
    "offset",
    "when",
    "then",
    "else",
    "end",
    "and",
    "or",
    "with"
  ].map((s) => s.toLowerCase())
)

export interface AliasBracketNormalization {
  query: string
  changed: boolean
  aliases: string[]
}

export interface AliasBracketViolation {
  kind: "unbracketed_alias_declaration" | "unbracketed_alias_reference"
  text: string
  line: number
  suggestion: string
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function lineOf(text: string, offset: number): number {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

function maskLiteralsAndComments(query: string): string {
  return query
    .replace(/--[^\r\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'(?:''|[^'])*'/g, (m) => " ".repeat(m.length))
    .replace(/"(?:\"\"|[^"])*"/g, (m) => " ".repeat(m.length))
}

interface ParsedAlias {
  name: string
  aliasStart: number
  aliasEnd: number
  alreadyBracketed: boolean
  declKind: "table" | "update_target" | "cte" | "bare_source"
}

interface ReadToken {
  name: string
  start: number
  end: number
  bracketed: boolean
}

function skipWs(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++
  return i
}

function findClosingParen(s: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < s.length; i++) {
    const c = s[i]
    if (c === "(") depth++
    else if (c === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function readToken(query: string, masked: string, i: number): ReadToken | null {
  i = skipWs(masked, i)
  if (i >= masked.length) return null

  if (masked[i] === "[") {
    const close = masked.indexOf("]", i + 1)
    if (close < 0) return null
    const name = query.slice(i + 1, close)
    return { name, start: i, end: close + 1, bracketed: true }
  }

  const m = masked.slice(i).match(new RegExp(`^${IDENT}`, "i"))
  if (!m) return null
  return { name: m[0], start: i, end: i + m[0].length, bracketed: false }
}

function skipTableHint(masked: string, i: number): number {
  i = skipWs(masked, i)
  if (!/^WITH\s*\(/i.test(masked.slice(i))) return i
  const open = masked.indexOf("(", i)
  if (open < 0) return i
  const close = findClosingParen(masked, open)
  return close >= 0 ? close + 1 : i
}

function parseTableRefEnd(masked: string, start: number): number {
  let i = skipWs(masked, start)
  if (i >= masked.length) return -1

  if (masked[i] === "(") {
    const close = findClosingParen(masked, i)
    return close >= 0 ? close + 1 : -1
  }

  const schemaTable = masked
    .slice(i)
    .match(
      new RegExp(
        String.raw`^(?:\[(?:[^\]]+)\]|${IDENT})\s*\.\s*(?:\[(?:[^\]]+)\]|${IDENT})`,
        "i"
      )
    )
  if (schemaTable) return i + schemaTable[0].length

  const temp = masked.slice(i).match(new RegExp(`^#${IDENT}`, "i"))
  if (temp) return i + temp[0].length

  const single = readToken(masked, masked, i)
  return single ? single.end : -1
}

function tryParseAliasAfterRef(query: string, masked: string, refEnd: number): ParsedAlias | null {
  let i = skipTableHint(masked, skipWs(masked, refEnd))

  const asMatch = masked.slice(i).match(/^AS\b/i)
  const hasAs = Boolean(asMatch)
  if (hasAs) {
    i += asMatch![0].length
    i = skipWs(masked, i)
  }

  const tok = readToken(query, masked, i)
  if (!tok) return null

  const lower = tok.name.toLowerCase()
  if (!hasAs && IMPLICIT_ALIAS_BLOCKLIST.has(lower)) {
    if (lower === "on") {
      const tail = masked.slice(tok.end).trimStart()
      if (tail.toUpperCase().startsWith("ON ")) return null
    }
    return null
  }

  return {
    name: tok.name,
    aliasStart: tok.start,
    aliasEnd: tok.end,
    alreadyBracketed: tok.bracketed,
    declKind: "table"
  }
}

function readBareSourceQualifier(
  query: string,
  masked: string,
  tableStart: number
): ParsedAlias | null {
  const i = skipWs(masked, tableStart)
  if (i >= masked.length || masked[i] === "(") return null

  const schemaTableRe = new RegExp(
    String.raw`^(\[(?:[^\]]+)\]|${IDENT})\s*\.\s*(\[(?:[^\]]+)\]|${IDENT})`,
    "i"
  )
  if (schemaTableRe.test(masked.slice(i))) {
    const dot = masked.indexOf(".", i)
    const tableTok = readToken(query, masked, dot + 1)
    if (!tableTok) return null
    return {
      name: tableTok.name,
      aliasStart: tableTok.start,
      aliasEnd: tableTok.end,
      alreadyBracketed: tableTok.bracketed,
      declKind: "bare_source"
    }
  }

  const temp = masked.slice(i).match(new RegExp(`^#${IDENT}`, "i"))
  if (temp) {
    return {
      name: query.slice(i, i + temp[0].length),
      aliasStart: i,
      aliasEnd: i + temp[0].length,
      alreadyBracketed: false,
      declKind: "bare_source"
    }
  }

  const single = readToken(query, masked, i)
  if (!single) return null
  return {
    name: single.name,
    aliasStart: single.start,
    aliasEnd: single.end,
    alreadyBracketed: single.bracketed,
    declKind: "bare_source"
  }
}

/** Parse CTE names from a top-level WITH clause (`WITH a AS (…), b AS (…)`). */
function parseCteNames(query: string, masked: string): ParsedAlias[] {
  let i = skipWs(masked, 0)
  if (masked[i] === ";") i = skipWs(masked, i + 1)

  const withMatch = masked.slice(i).match(/^WITH\b/i)
  if (!withMatch) return []

  i += withMatch[0].length
  const out: ParsedAlias[] = []

  while (i < masked.length) {
    i = skipWs(masked, i)
    const tok = readToken(query, masked, i)
    if (!tok) break

    i = skipWs(masked, tok.end)
    if (!/^AS\s*\(/i.test(masked.slice(i))) break

    out.push({
      name: tok.name,
      aliasStart: tok.start,
      aliasEnd: tok.end,
      alreadyBracketed: tok.bracketed,
      declKind: "cte"
    })

    const open = masked.indexOf("(", i)
    if (open < 0) break
    const close = findClosingParen(masked, open)
    if (close < 0) break
    i = skipWs(masked, close + 1)

    if (masked[i] === ",") {
      i++
      continue
    }
    break
  }

  return out
}

/**
 * Read a bare single-identifier source name at `tableStart` — the CTE or bare
 * table name in `FROM cte AS x`. Returns null for schema-qualified sources
 * (`dim.Client`, convention leaves these unbracketed), subquery sources
 * `(SELECT …)`, and `#temp` sources (left bare so `#`-pattern detectors work).
 *
 * This is what lets the CTE *source* name itself get bracketed separately from
 * its alias — `FROM topClients AS tc` → `FROM [topClients] AS [tc]`.
 */
function readBareSingleSource(
  query: string,
  masked: string,
  tableStart: number
): ParsedAlias | null {
  const i = skipWs(masked, tableStart)
  if (i >= masked.length || masked[i] === "(") return null

  const schemaTableRe = new RegExp(
    String.raw`^(?:\[(?:[^\]]+)\]|${IDENT})\s*\.\s*(?:\[(?:[^\]]+)\]|${IDENT})`,
    "i"
  )
  if (schemaTableRe.test(masked.slice(i))) return null

  // #temp names are left bare: the `#` prefix already disambiguates them, and
  // several downstream guards (temp-scalar-probe, large-object refs) scan for
  // the literal `#name` pattern. Only CTE / bare table names get bracketed.
  if (masked[i] === "#") return null

  const single = readToken(query, masked, i)
  if (!single) return null
  return {
    name: single.name,
    aliasStart: single.start,
    aliasEnd: single.end,
    alreadyBracketed: single.bracketed,
    declKind: "bare_source"
  }
}

function addTableSource(
  query: string,
  masked: string,
  out: ParsedAlias[],
  aliasNames: Set<string>,
  tableClausePos: number
): number {
  const tableStart = skipWs(masked, tableClausePos)
  const refEnd = parseTableRefEnd(masked, tableClausePos)
  if (refEnd < 0) return tableClausePos

  const alias = tryParseAliasAfterRef(query, masked, refEnd)
  if (alias) {
    // Bracket the bare CTE/table source name too (FROM [cte] AS x), not just
    // the alias. Schema-qualified, subquery, and #temp sources are left alone.
    addAlias(out, aliasNames, readBareSingleSource(query, masked, tableStart))
    addAlias(out, aliasNames, alias)
    return alias.aliasEnd
  }

  addAlias(out, aliasNames, readBareSourceQualifier(query, masked, tableStart))
  return refEnd
}

function addAlias(out: ParsedAlias[], aliasNames: Set<string>, alias: ParsedAlias | null): void {
  if (!alias) return
  out.push(alias)
  aliasNames.add(alias.name.toLowerCase())
}

function scanCommaSeparatedSources(
  query: string,
  masked: string,
  out: ParsedAlias[],
  aliasNames: Set<string>,
  startPos: number
): void {
  let scan = startPos

  while (true) {
    scan = skipWs(masked, scan)
    if (masked[scan] !== ",") break
    scan++
    scan = addTableSource(query, masked, out, aliasNames, scan)
  }
}

/**
 * Parse qualifiers from WITH CTEs, FROM/JOIN (incl. subqueries), comma joins, and UPDATE targets.
 */
function parseTableAliases(query: string, masked: string): ParsedAlias[] {
  const out: ParsedAlias[] = []
  const aliasNames = new Set<string>()

  for (const cte of parseCteNames(query, masked)) {
    addAlias(out, aliasNames, cte)
  }

  const clauseRe =
    /\b(?:FROM|UPDATE|(?:INNER|LEFT|RIGHT|FULL|CROSS)?\s*(?:OUTER\s+)?JOIN)\b/gi

  let m: RegExpExecArray | null
  while ((m = clauseRe.exec(masked)) !== null) {
    const kw = m[0].replace(/\s+/g, " ").trim().toUpperCase()
    const pos = m.index + m[0].length

    if (kw === "UPDATE") {
      const aliasTok = readToken(query, masked, pos)
      if (!aliasTok) continue
      const after = masked.slice(aliasTok.end).trimStart().toUpperCase()
      if (!after.startsWith("SET")) continue
      addAlias(out, aliasNames, {
        name: aliasTok.name,
        aliasStart: aliasTok.start,
        aliasEnd: aliasTok.end,
        alreadyBracketed: aliasTok.bracketed,
        declKind: "update_target"
      })
      continue
    }

    const afterSource = addTableSource(query, masked, out, aliasNames, pos)
    scanCommaSeparatedSources(query, masked, out, aliasNames, afterSource)
  }

  return out
}

function bracketAliasDecl(query: string, parsed: ParsedAlias): string {
  if (parsed.alreadyBracketed) return query
  const { name, aliasStart, aliasEnd, declKind } = parsed
  const before = query.slice(0, aliasStart)
  const after = query.slice(aliasEnd)
  if (declKind === "update_target" || declKind === "cte" || declKind === "bare_source") {
    return `${before}[${name}]${after}`
  }
  if (/\bAS\s*$/i.test(before)) {
    return `${before}[${name}]${after}`
  }
  return `${before.replace(/\s+$/, "")} AS [${name}]${after}`
}

function declViolationSuggestion(p: ParsedAlias): string {
  switch (p.declKind) {
    case "cte":
      return `Use WITH [${p.name}] AS — bare CTE name \`${p.name}\` is not allowed.`
    case "bare_source":
      return `Use FROM [${p.name}] — bracket table/CTE name \`${p.name}\`.`
    case "update_target":
      return `Use UPDATE [${p.name}] — bare target alias is not allowed.`
    default:
      return `Use AS [${p.name}] — bare alias \`${p.name}\` is not allowed.`
  }
}

function bracketAliasReferences(query: string, aliases: string[]): string {
  const masked = maskLiteralsAndComments(query)
  const sorted = [...aliases].sort((a, b) => b.length - a.length)
  const replacements: Array<{ start: number; end: number; text: string }> = []

  for (const alias of sorted) {
    const esc = escapeRegExp(alias)
    const refRe = new RegExp(
      String.raw`(?<!\[)\b${esc}\s*\.\s*(?:\[(${IDENT})\]|(${IDENT}))(?!\s*\()`,
      "gi"
    )
    let m: RegExpExecArray | null
    while ((m = refRe.exec(masked)) !== null) {
      const col = m[1] ?? m[2]
      replacements.push({
        start: m.index,
        end: m.index + m[0].length,
        text: `[${alias}].[${col}]`
      })
    }
  }

  replacements.sort((a, b) => b.start - a.start)
  let out = query
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.text + out.slice(r.end)
  }
  return out
}

/** Rewrite table aliases to bracket form. Idempotent on already-compliant SQL. */
export function normalizeMssqlAliasBrackets(query: string): AliasBracketNormalization {
  let out = query
  let changed = false
  const masked = maskLiteralsAndComments(out)

  const parsed = parseTableAliases(out, masked)
  const aliases: string[] = [...new Set(parsed.map((p) => p.name))]

  for (const p of [...parsed].sort((a, b) => b.aliasStart - a.aliasStart)) {
    if (p.alreadyBracketed) continue
    const next = bracketAliasDecl(out, p)
    if (next !== out) {
      out = next
      changed = true
    }
  }

  const nextRefs = bracketAliasReferences(out, aliases)
  if (nextRefs !== out) {
    out = nextRefs
    changed = true
  }

  return { query: out, changed, aliases }
}

export function detectAliasBracketViolations(query: string): AliasBracketViolation[] {
  const out: AliasBracketViolation[] = []
  const masked = maskLiteralsAndComments(query)
  const parsed = parseTableAliases(query, masked)

  for (const p of parsed) {
    if (p.alreadyBracketed) continue
    const snippet = query.slice(Math.max(0, p.aliasStart - 24), p.aliasEnd + 8).trim()
    out.push({
      kind: "unbracketed_alias_declaration",
      text: snippet,
      line: lineOf(query, p.aliasStart),
      suggestion: declViolationSuggestion(p)
    })
  }

  const sorted = [...parsed.map((p) => p.name)].sort((a, b) => b.length - a.length)
  for (const alias of sorted) {
    const esc = escapeRegExp(alias)
    const refRe = new RegExp(String.raw`(?<!\[)\b${esc}\s*\.\s*${IDENT}`, "gi")
    let m: RegExpExecArray | null
    while ((m = refRe.exec(masked)) !== null) {
      out.push({
        kind: "unbracketed_alias_reference",
        text: query.slice(m.index, m.index + m[0].length),
        line: lineOf(query, m.index),
        suggestion: `Write [${alias}].[Column] instead of ${m[0]}.`
      })
    }
  }

  return out
}

export function validateAliasBracketConvention(query: string): string | null {
  const violations = detectAliasBracketViolations(query)
  if (violations.length === 0) return null

  const lines = violations.slice(0, 6).map((v) => `  - line ${v.line}: ${v.text} — ${v.suggestion}`)
  const more = violations.length > 6 ? `\n  …and ${violations.length - 6} more.` : ""

  return [
    "Query blocked — table alias bracket convention violated.",
    "",
    "Every table alias MUST use bracket identifiers in declaration and references:",
    "  WITH [cte] AS (SELECT …)",
    "  FROM dim.Officer AS [off]",
    "  SELECT [cte].[n] FROM [cte]",
    "  INNER JOIN publish.Revenue AS [r] ON [r].[pkOfficer] = [off].[pkOfficer]",
    "",
    "Never: FROM dim.Officer off  /  ON r.pk = off.pk",
    "",
    "Violations:",
    lines.join("\n") + more
  ].join("\n")
}

export function prepareMssqlQueryAliases(query: string): {
  query: string
  changed: boolean
  error: string | null
} {
  const { query: normalized, changed } = normalizeMssqlAliasBrackets(query)
  const error = validateAliasBracketConvention(normalized)
  return { query: normalized, changed, error }
}
