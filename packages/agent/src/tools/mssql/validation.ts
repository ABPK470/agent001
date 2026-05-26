// ── Query validation ─────────────────────────────────────────────

import { getTenantConfig } from "../../application/shell/tenant-config.js"
import { DOCTRINE_FIX_HINTS, getDoctrineLessonTemplate } from "../../doctrine/fix-hints.js"
import { AggregateFamily, AggregateSeverity } from "../../domain/enums/sql-guard.js"
import type { CatalogAccessor } from "../catalog/index.js"
import {
    _resetCatalogQueriesCache,
    calendarDimensionTable,
    canonicalQualifiedName,
    isLargeObject as catalogIsLargeObject,
    dateGrainColumn,
    highCardinalityKeyColumns,
    isExpensiveUnionView,
    listLargeObjects,
    listSchemas,
    persistedMirrorOf,
    primaryKeyColumns,
    unionBranchCount,
} from "../catalog/queries.js"

/** Appends a doctrine-owned fixHint to an error string, when one is registered. */
function withFixHint(error: string, code: string): string {
  const hint = DOCTRINE_FIX_HINTS[code]
  return hint ? `${error}\n\nFix: ${hint}` : error
}

const READ_ONLY_PATTERN = /^\s*(SELECT|WITH|EXPLAIN|SET\s+SHOWPLAN|SP_HELP|SP_COLUMNS|SP_TABLES)\b/i

// Allowed openers when every DDL/DML target is a local temp table (#name).
// Local #temp tables are session-scoped (auto-drop on connection close, isolated per
// SPID) so the agent can stage micro-ETL slices safely without ever touching real
// objects. Global ##temp tables are NOT allowed — they leak across sessions.
const TMP_TABLE_OPENER = /^\s*(CREATE|INSERT|UPDATE|DELETE|DROP|TRUNCATE|MERGE|SET\s+IDENTITY_INSERT)\b/i

const DANGEROUS_PATTERNS = [
  // EXEC / dynamic-SQL / external-data routes — never legitimate from the agent.
  // Note: DROP / ALTER / TRUNCATE are deliberately NOT here anymore. Those are
  // permitted *only* when their target is a local #temp table — that constraint
  // is enforced by findNonTmpMutations() below, not by a blunt prefix block.
  /\b(EXEC|EXECUTE|XP_|SP_EXECUTESQL|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b/i,
  /BULK\s+INSERT/i,
  /DBCC\b/i,
  /SHUTDOWN\b/i,
  /RECONFIGURE\b/i,
]

// Statements that mutate a non-temp object. Used to scan multi-statement batches —
// any one of these targeting a real table/view/index must reject the whole batch.
// Notes on each form:
//   • CREATE / DROP / TRUNCATE / ALTER on TABLE | VIEW | INDEX | PROCEDURE | FUNCTION | TRIGGER
//   • INSERT INTO <target>     — target must be #name
//   • UPDATE <target>          — target must be #name (UPDATE has no INTO keyword)
//   • DELETE FROM <target>     — target must be #name
//   • SELECT … INTO <target>   — target must be #name
//   • MERGE INTO <target>      — target must be #name
//
// For each pattern the captured group is the object name; the post-check enforces
// it starts with a single '#' (and not '##').
const MUTATION_PATTERNS: { re: RegExp; label: string }[] = [
  // CREATE/DROP INDEX: the index name comes first, the *target* table/view name
  // follows ON — that is what the temp-only constraint must apply to.
  { re: /\bCREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+\[?\w+\]?\s+ON\s+(\[?[#\w.]+\]?)/gi, label: "CREATE INDEX" },
  { re: /\bDROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?\[?\w+\]?\s+ON\s+(\[?[#\w.]+\]?)/gi,                                label: "DROP INDEX" },
  // CREATE/DROP/ALTER on objects whose name follows the keyword directly.
  { re: /\bCREATE\s+(?:OR\s+ALTER\s+)?(?:TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER|SCHEMA|DATABASE)\s+(\[?[#\w.]+\]?)/gi, label: "CREATE" },
  { re: /\bDROP\s+(?:TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER|SCHEMA|DATABASE)\s+(?:IF\s+EXISTS\s+)?(\[?[#\w.]+\]?)/gi,   label: "DROP" },
  { re: /\bTRUNCATE\s+TABLE\s+(\[?[#\w.]+\]?)/gi,                                                                              label: "TRUNCATE" },
  { re: /\bALTER\s+(?:TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER|SCHEMA|DATABASE)\s+(\[?[#\w.]+\]?)/gi,                       label: "ALTER" },
  { re: /\bINSERT\s+INTO\s+(\[?[#\w.]+\]?)/gi,                                                                                  label: "INSERT" },
  { re: /\bUPDATE\s+(\[?[#\w.]+\]?)/gi,                                                                                         label: "UPDATE" },
  { re: /\bDELETE\s+FROM\s+(\[?[#\w.]+\]?)/gi,                                                                                  label: "DELETE" },
  { re: /\bSELECT\b[\s\S]*?\bINTO\s+(\[?[#\w.]+\]?)\s+FROM\b/gi,                                                                label: "SELECT INTO" },
  { re: /\bMERGE\s+(?:INTO\s+)?(\[?[#\w.]+\]?)/gi,                                                                              label: "MERGE" },
]

/** Returns {name, label} for any mutation statement whose target is NOT a local #temp table. */
export function findNonTmpMutations(query: string): { target: string; label: string }[] {
  const stripped = query
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'[^']*'/g, "''")

  const offenders: { target: string; label: string }[] = []
  for (const { re, label } of MUTATION_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const raw = m[1].replace(/\[|\]/g, "")
      // Allow only single-# local temp tables (no schema prefix permitted).
      const isLocalTmp = /^#[A-Za-z_][\w]*$/.test(raw)
      if (!isLocalTmp) offenders.push({ target: raw, label })
    }
  }
  return offenders
}

// ── Scan-guard: tables/views known to be large ──────────────────
//
// "Large" is derived entirely from the live catalog (rowCount from
// sys.dm_db_partition_stats for tables, viewSourceRows — sum of
// referenced physical-table row-counts — for views). Threshold is
// configurable via `tenantConfig.largeObjectRows`; default 10M.
//
// There is NO hardcoded customer-name fallback. When the catalog isn't
// loaded yet (early startup, unit tests with no fixture), the guard is
// silent — `isUnsafeScan` still catches unfiltered shapes structurally,
// and the agent's own discipline (search_catalog before query_mssql)
// surfaces the size before any scan.

/** Re-export — kept for test cache invalidation. */
export function _resetLargeObjectCache(): void {
  _resetCatalogQueriesCache()
}

/**
 * Predicate: is the given schema-qualified name a known-large object?
 * Delegates to the catalog facade so the threshold and shape rules stay
 * defined in one place. Returns false when no catalog is loaded.
 */
export function isLargeObject(
  qualifiedName: string,
  accessor?: () => unknown,
): boolean {
  return catalogIsLargeObject(qualifiedName, {
    threshold: getTenantConfig().largeObjectRows,
    accessor: accessor as never,
  })
}

/**
 * Match every schema.object reference (including 3-part `<mirrorSchema>.<schema>.<object>`
 * forms) in the query text. Strips comments first. The set of "large"
 * objects comes from the catalog at call time, so adding a new fact
 * table or growing a view past the threshold takes effect immediately.
 */
function* iterateObjectRefs(query: string): IterableIterator<string> {
  const stripped = query
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  // 2-part: [schema].[name] / schema.name (`name` may itself contain a dot
  // when bracketed — e.g. mirrorSchema.[publish.Revenue]).
  const re = /\[?(\w+)\]?\.\[?([\w]+(?:\.\w+)?)\]?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    yield `${m[1].toLowerCase()}.${m[2].toLowerCase()}`
  }
}

/** Lowercased schema.object names in `query` that the catalog classifies as large. */
export function referencedLargeObjects(query: string, accessor?: CatalogAccessor): string[] {
  const large = listLargeObjects({ accessor, threshold: getTenantConfig().largeObjectRows })
  const found: string[] = []
  for (const key of iterateObjectRefs(query)) {
    if (large.has(key) && !found.includes(key)) found.push(key)
  }
  return found
}

/** Per-object reference counts (lowercased) of catalog-large objects in `query`. */
export function countReferencedLargeObjects(query: string, accessor?: CatalogAccessor): Map<string, number> {
  const large = listLargeObjects({ accessor, threshold: getTenantConfig().largeObjectRows })
  const counts = new Map<string, number>()
  for (const key of iterateObjectRefs(query)) {
    if (!large.has(key)) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

export interface TempTableBatchAnalysis {
  readonly refs: readonly string[]
  readonly created: readonly string[]
  readonly suffixes: readonly string[]
  readonly malformedSuffixes: readonly string[]
  readonly missingCreations: readonly string[]
}

export interface MssqlQueryQualityAnalysis {
  readonly largeObjectRefs: ReadonlyArray<{ name: string; count: number }>
  readonly usesPersistedMirrors: readonly string[]
  readonly missingPersistedMirrorCandidates: readonly string[]
  readonly hasWhereClause: boolean
  readonly unsafeScanReason: string | null
  readonly tempTableRefs: number
  readonly tempTablesCreated: number
  readonly tempTableSuffixes: readonly string[]
  readonly malformedTempSuffixes: readonly string[]
  readonly missingTempCreations: readonly string[]
  readonly aggregateWarningCount: number
  readonly aggregateBlockCount: number
  readonly tempScalarSubqueryCount: number
  readonly stagePatternLikely: boolean
}

export type QueryValidationCode =
  | "dangerous_operation"
  | "aggregate_semantic_mismatch"
  | "temp_table_integrity"
  | "temp_scalar_subquery_overused"
  | "publish_view_topn_without_branch_aggregation"
  | "avg_of_coalesce_zero"
  | "invented_column"
  | "write_disabled"
  | "non_temp_mutation"
  | "large_object_overused"
  | "unsafe_large_object_scan"

export interface QueryValidationDiagnostics {
  readonly ok: boolean
  readonly error: string | null
  readonly code: QueryValidationCode | null
  readonly analysis: MssqlQueryQualityAnalysis
  /**
   * Optional auto-note payload (Gap 2). When a doctrine block fires AND a
   * lesson template exists for its code, the validator emits the lesson so
   * the calling tool can route it to the agent's memory writer. Pure data;
   * the validator has no side effects.
   */
  readonly lesson?: import("../../doctrine/fix-hints.js").NoteLessonPayload | null
}

function analyzeTempTableBatch(query: string): TempTableBatchAnalysis {
  const refs = extractLocalTempRefs(query)
  const created = extractCreatedLocalTemps(query)
  const malformedSuffixes = refs.filter((name) => /_[A-Fa-f0-9]+$/.test(name) && !/_([A-Fa-f0-9]{8})$/.test(name))
  const missingCreations = created.length > 0
    ? refs.filter((name) => !created.includes(name))
    : []
  const suffixes = Array.from(new Set(
    refs
      .map((name) => /_([A-Fa-f0-9]{8})$/.exec(name)?.[1]?.toLowerCase() ?? null)
      .filter((suffix): suffix is string => suffix !== null),
  ))
  return { refs, created, suffixes, malformedSuffixes, missingCreations }
}

/**
 * Walks a SQL string and returns every parenthesised SELECT subquery whose
 * FROM clause references a local #temp table, classified as scalar or not.
 *
 * "Scalar" here means the anti-pattern we actually care about: a subquery
 * that returns ONE value (aggregate or TOP 1, single output column) embedded
 * in a SELECT-list expression — typically `SELECT ..., (SELECT SUM(x) FROM
 * #temp WHERE corr), (SELECT COUNT(*) FROM #temp WHERE corr), ...`. That
 * shape forces N re-scans of the staged data.
 *
 * Disqualified (these are LEGITIMATE shapes that older heuristic flagged):
 *   • `IN (SELECT ... FROM #temp)`       — set predicate
 *   • `EXISTS (SELECT ... FROM #temp)`   — set predicate
 *   • `ANY/SOME/ALL (SELECT …)`          — set predicate
 *   • `FROM (SELECT ... FROM #temp) x`   — derived table
 *   • `JOIN (SELECT ...) x ON …`         — derived table
 *   • `OUTER/CROSS APPLY (SELECT …)`     — apply operator
 *   • `WITH name AS (SELECT ... FROM #temp …)` — CTE body
 *   • Subquery body without aggregate / TOP 1 (returns a set, not a scalar)
 *   • Subquery body with multiple top-level select-list columns
 *
 * Uses a real paren walker (not a non-greedy regex) so nested parens in
 * aggregate calls don't confuse the boundaries.
 */
interface TempSubqueryFinding {
  readonly temp: string
  readonly scalar: boolean
}

function findTempSubqueries(query: string): TempSubqueryFinding[] {
  const text = stripForScan(query)
  const findings: TempSubqueryFinding[] = []

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "(") continue
    // Look ahead past whitespace for SELECT
    let j = i + 1
    while (j < text.length && /\s/.test(text[j])) j++
    if (!/^select\b/i.test(text.slice(j, j + 7))) continue

    // Find matching close paren
    let depth = 1
    let k = i + 1
    while (k < text.length && depth > 0) {
      const c = text[k]
      if (c === "(") depth++
      else if (c === ")") depth--
      if (depth === 0) break
      k++
    }
    if (depth !== 0) continue
    const body = text.slice(i + 1, k)

    // Must reference a #temp in its FROM clause
    const tempMatch = /\bFROM\s+(#[A-Za-z_][\w]*)/i.exec(body)
    if (!tempMatch) continue
    const temp = tempMatch[1]

    // Classify by the token immediately preceding the opening paren
    const before = text.slice(Math.max(0, i - 40), i)
    const lastTokenMatch = /([A-Za-z_][\w]*)\s*$/.exec(before)
    const lastToken = lastTokenMatch?.[1]?.toUpperCase() ?? ""
    const isSetOrDerived = /^(IN|EXISTS|ANY|SOME|ALL|FROM|JOIN|AS|APPLY|UNION|INTERSECT|EXCEPT)$/.test(lastToken)

    // Body shape: scalar requires aggregate or TOP 1, AND a single select-list column
    const selectListMatch = /\bSELECT\s+(?:DISTINCT\s+|TOP\s+\d+\s+)?([\s\S]*?)\s+FROM\b/i.exec(body)
    const selectList = selectListMatch?.[1] ?? ""
    const hasAgg = /\b(SUM|AVG|MIN|MAX|COUNT|STRING_AGG|STDEV|VAR)\s*\(/i.test(selectList)
    const hasTop1 = /\bTOP\s+1\b/i.test(body)
    const singleColumn = selectList.length > 0 && countTopLevelCommas(selectList) === 0

    const scalar = !isSetOrDerived && singleColumn && (hasAgg || hasTop1)
    findings.push({ temp, scalar })

    i = k // skip past this subquery
  }

  return findings
}

function countTopLevelCommas(expr: string): number {
  let depth = 0
  let count = 0
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (c === "(") depth++
    else if (c === ")") depth--
    else if (c === "," && depth === 0) count++
  }
  return count
}

function countTempScalarSubqueries(query: string): number {
  return findTempSubqueries(query).filter((f) => f.scalar).length
}

export function countTempScalarSubqueriesByTemp(query: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const finding of findTempSubqueries(query)) {
    if (!finding.scalar) continue
    counts.set(finding.temp, (counts.get(finding.temp) ?? 0) + 1)
  }
  return counts
}

// ── Branch-aggregation guard for wide UNION views ───────────────
//
// Any TABLE/VIEW the catalog classifies as an "expensive UNION view"
// (≥ tenantConfig.unionBranchThreshold UNION ALL branches) cannot be the
// outer FROM of a `TOP N … GROUP BY <high-cardinality-key>` statement —
// the engine has to expand every branch, materialise the full union,
// then group and sort globally. No branch-local index can help and the
// statement times out.
//
// The correct shape is per-branch pre-aggregation under a derived
// table, then UNION ALL of the branch results, then the outer TOP/GROUP.
// The fix is documented in the wide-union-view-policy doctrine.
//
// What counts as "high-cardinality": the live catalog's PK columns plus
// FK-out columns whose target is a centrally-referenced dimension (≥3
// incoming FKs). No name list — pkClient/pkAccount/cust_id/whatever the
// deployment calls them is discovered from PK/FK metadata.
export interface WideUnionViewTopnOffender {
  /** The wide UNION view at the outer FROM, e.g. "publish.Revenue". */
  readonly object: string
  /** The high-card key found in GROUP BY (the column NAME as written). */
  readonly groupKey: string
  /** Branches the catalog reports for `object`. */
  readonly branchCount: number
}

/**
 * Extract every `FROM <schema>.<table>` reference in the outer query
 * statement (i.e. not inside a parenthesised derived table). Returns the
 * normalised lowercased `schema.table` keys in source order.
 *
 * We approximate "outer" by tracking paren depth: anything opened with
 * `(` that contains a SELECT is a subquery and is skipped. This is
 * good enough for the branch-aggregation guard — false-positives on
 * deeply-nested derived tables only suppress a (correctly-applied)
 * block, never invent one.
 */
function outerFromTargets(stmt: string): string[] {
  const out: string[] = []
  let depth = 0
  const re = /[()]|\bFROM\s+\[?(\w+)\]?\.\[?([\w]+(?:\.\w+)?)\]?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(stmt)) !== null) {
    const token = m[0][0]
    if (token === "(") { depth++; continue }
    if (token === ")") { depth = Math.max(0, depth - 1); continue }
    if (depth === 0 && m[1] && m[2]) out.push(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`)
  }
  return out
}

export function detectWideUnionViewTopnWithoutBranchAggregation(
  query: string,
  options: { accessor?: CatalogAccessor } = {},
): WideUnionViewTopnOffender | null {
  const tc = getTenantConfig()
  const stripped = stripForScan(query)
  // Naive statement split — `stripForScan` already removed string literals and
  // comments, so semicolons here are real statement boundaries.
  for (const stmt of stripped.split(/;\s*/)) {
    if (!stmt.trim()) continue
    if (!/\bTOP\s+\d+\b/i.test(stmt)) continue
    const groupByMatch = /\bGROUP\s+BY\b([\s\S]*?)(?:\bORDER\s+BY\b|\bHAVING\b|\bOPTION\b|$)/i.exec(stmt)
    if (!groupByMatch) continue
    const groupBody = groupByMatch[1]

    for (const fromTarget of outerFromTargets(stmt)) {
      if (!isExpensiveUnionView(fromTarget, { accessor: options.accessor, threshold: tc.unionBranchThreshold })) continue
      // Catalog says this FROM target is a wide UNION view. Check whether
      // GROUP BY mentions any of its high-cardinality keys.
      const highCardKeys = highCardinalityKeyColumns(fromTarget, { accessor: options.accessor })
      if (highCardKeys.length === 0) continue
      let matchedKey: string | null = null
      for (const key of highCardKeys) {
        const keyRe = new RegExp(`\\b${escapeRegExp(key)}\\b`, "i")
        if (keyRe.test(groupBody)) { matchedKey = key; break }
      }
      if (!matchedKey) continue

      // Escape valve: a JOIN to a #temp on the same key is exactly the
      // narrowing pattern we WANT (the temp's small key set pushes into
      // each branch).
      const narrowingJoin = new RegExp(
        `\\bJOIN\\s+#\\w+\\b[\\s\\S]{0,200}?\\bON\\b[\\s\\S]{0,200}?\\b${escapeRegExp(matchedKey)}\\b\\s*=`,
        "i",
      ).test(stmt)
      if (narrowingJoin) continue

      return {
        object: canonicalQualifiedName(fromTarget, { accessor: options.accessor }),
        groupKey: matchedKey,
        branchCount: unionBranchCount(fromTarget, { accessor: options.accessor }),
      }
    }
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** @deprecated Renamed to `detectWideUnionViewTopnWithoutBranchAggregation`. */
export const detectPublishViewTopnWithoutBranchAggregation = detectWideUnionViewTopnWithoutBranchAggregation
export type PublishViewTopnOffender = WideUnionViewTopnOffender

// ── AVG-of-zero-coalesce statistical guard ──────────────────────────
//
// `AVG(COALESCE(col, 0))` or `AVG(ISNULL(col, 0))` is almost never what a
// controller wants: it treats a missing observation as an observed zero,
// dragging the average down. Trace 2026-05-21 had the agent emit
// `AVG(COALESCE(bl.AverageCreditBalanceZARMTD, 0))` across 6 balance columns —
// every reported "average balance" would have been silently understated for
// any client missing a month.
//
// The correct shape is `AVG(col)` (T-SQL `AVG` already ignores NULLs) or, if
// the model is "missing month = real zero", an explicit denominator —
// `SUM(COALESCE(col, 0)) / NULLIF(<MonthsExpected>, 0)`. The latter makes the
// assumption visible.
export interface AvgOfCoalesceZeroOffender {
  readonly snippet: string  // the offending expression, trimmed for display
}

export function detectAvgOfCoalesceZero(query: string): AvgOfCoalesceZeroOffender[] {
  const stripped = stripForScan(query)
  const offenders: AvgOfCoalesceZeroOffender[] = []
  // AVG ( {COALESCE|ISNULL} ( <expr>, 0 ) )  — `<expr>` may contain qualified
  // column names and dots/brackets but no commas (the 2-arg form is what bites).
  const re = /\bAVG\s*\(\s*(?:COALESCE|ISNULL)\s*\(\s*[^,()]+,\s*0\s*\)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const snippet = m[0].replace(/\s+/g, " ").trim()
    if (!offenders.some((o) => o.snippet === snippet)) offenders.push({ snippet })
  }
  return offenders
}

// ── Invented-column guard ───────────────────────────────────────
//
// The 2026-05-21 cancelled run had the model emit `r.ClientName`,
// `publish.Officer.fullName`, `rbb.RBBBanker` — none of which exist in the
// live catalog. The agent had no way to know it was hallucinating, so it
// burned a 60-second timeout per attempt and silently produced rows whose
// "names" / "bankers" were just whatever the unionised mapping branch chose
// to surface (which is usually NULL or an obscure code).
//
// This guard reads the live catalog (built at startup from sys.all_columns)
// and rejects qualified column references whose column does NOT exist on
// the table the alias points to. It is intentionally CONSERVATIVE: when
// alias provenance is ambiguous (CTE, derived table, UNION), it skips the
// whole statement rather than risk a false positive.
//
// Catalog access is sync (`getCatalog()` returns an in-memory snapshot).
// When no catalog is loaded (early startup, unit tests, server-less mode),
// the detector returns [] — it never blocks on absence of evidence.

export interface InventedColumnOffender {
  /** The qualified reference as it appears, e.g. "r.ClientName". */
  readonly reference: string
  /** The catalog table that was inspected, e.g. "publish.Revenue". */
  readonly table: string
  /** The column name that was not found. */
  readonly column: string
  /** Closest live column names on the same table, for the fix hint. */
  readonly suggestions: readonly string[]
}

/** SQL keywords that must never be treated as an alias when seen left of `.col`. */
const ALIAS_RESERVED_KEYWORDS = new Set([
  "select", "from", "where", "join", "inner", "outer", "left", "right", "full",
  "cross", "apply", "on", "as", "and", "or", "not", "in", "exists", "between",
  "is", "null", "case", "when", "then", "else", "end", "by", "group", "order",
  "having", "union", "intersect", "except", "with", "into", "values", "set",
  "top", "distinct", "all", "any", "some", "over", "partition", "rows", "range",
  "unbounded", "preceding", "following", "current", "row", "asc", "desc",
  "option", "recompile", "maxdop", "nolock", "readonly", "tablock", "tablockx",
  "holdlock", "updlock", "rowlock", "paglock", "index", "noexpand", "fastfirstrow",
  // System schemas that are universal across MSSQL deployments.
  "sys", "information_schema", "dbo",
])

/**
 * Full reserved-alias set = SQL keywords above + every live schema in the
 * catalog + tenant-configured extras. Aliasing a schema name confuses the
 * column-reference resolver, so we treat schemas the same as keywords.
 *
 * Recomputed on each call — the catalog query is O(1) (precomputed list)
 * and the set construction is cheap; this avoids stale caches when the
 * catalog or tenant config changes between calls.
 */
function reservedAliasSet(): Set<string> {
  const out = new Set(ALIAS_RESERVED_KEYWORDS)
  for (const s of listSchemas()) out.add(s)
  for (const s of getTenantConfig().reservedAliases) out.add(s.toLowerCase())
  return out
}

/** Bare table/column tokens that almost certainly aren't real columns. */
const NON_COLUMN_TOKEN = new Set([
  "asc", "desc", "as", "and", "or", "is", "null", "on", "in", "from", "join",
])

interface AliasBinding {
  alias: string
  qualifiedTable: string  // "schema.table" — guaranteed to exist in the catalog
}

interface CatalogLike {
  getTable(qualifiedName: string): { columns: ReadonlyArray<{ name: string }> } | null
}

const EMPTY_CATALOG_ACCESSOR: CatalogAccessor = () => null

/** Editor distance for "did you mean" suggestions; small + cheap, no deps. */
function nearestColumns(target: string, columns: ReadonlyArray<{ name: string }>, k = 3): string[] {
  const t = target.toLowerCase()
  const scored = columns.map((c) => {
    const n = c.name.toLowerCase()
    let d = 0
    // Substring containment scores best, then shared-prefix length.
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
  return scored.slice(0, k).map((s) => s.name)
}

/**
 * Conservative column-existence guard. Returns the list of qualified
 * column references whose column is provably absent from the catalog table
 * the alias resolves to. Statements with CTEs, derived tables, set
 * operators, or sys.* references are skipped (returned offenders only
 * cover statements where alias provenance is unambiguous).
 */
export function detectInventedColumns(
  query: string,
  accessor: () => CatalogLike | null = EMPTY_CATALOG_ACCESSOR,
): InventedColumnOffender[] {
  const catalog = accessor()
  if (!catalog) return []

  const stripped = stripForScan(query)
    // Strip MSSQL table hints — `WITH (NOLOCK)`, `WITH (INDEX=ix)` — they contain
    // identifiers that must not be mistaken for column references.
    .replace(/\bWITH\s*\([^)]*\)/gi, (m) => " ".repeat(m.length))

  const reservedAliases = reservedAliasSet()
  const offenders: InventedColumnOffender[] = []
  const seen = new Set<string>()

  // Statement split — stripForScan already removed string literals/comments.
  const statements = stripped.split(/;\s*/)
  for (const stmt of statements) {
    if (!stmt.trim()) continue

    // Skip provenance-ambiguous shapes — safer to under-report than false-block.
    //
    // Note (2026-05-23): the CTE skip (`WITH … AS (…)`) was REMOVED here.
    // It was suppressing the check on every analytical query in the wild
    // (the model almost always uses CTEs), so hallucinated columns like
    // `r.VolumeUSDMTD` / `r.RevenueAmountCY` against `publish.Revenue` were
    // sailing through to SQL Server. The remaining skips below stay because
    // they materially change alias→table provenance; a CTE introduces a new
    // *name* but every alias bound to a real `schema.table` in FROM/JOIN
    // still resolves unambiguously (CTE aliases lack a schema prefix and
    // therefore never enter `fromJoinRe`). The narrow residual risk is a
    // CTE that re-uses the same alias letter as the outer query against a
    // different base table — accepted in exchange for catching the entire
    // hallucinated-column family at parse time instead of at SQL Server.
    if (/\bFROM\s*\(\s*SELECT\b/i.test(stmt)) continue               // derived FROM
    if (/\bJOIN\s*\(\s*SELECT\b/i.test(stmt)) continue               // derived JOIN
    if (/\bUNION\b|\bINTERSECT\b|\bEXCEPT\b/i.test(stmt)) continue   // set ops
    if (/\bsys\.|\bINFORMATION_SCHEMA\b/i.test(stmt)) continue       // system catalog
    if (/\bOPENJSON\b|\bOPENROWSET\b|\bSTRING_SPLIT\b/i.test(stmt)) continue  // TVFs

    // Build alias map from FROM/JOIN <schema>.<table> [AS] <alias>.
    // Anchor on schema.table to avoid mis-parsing #temp / @var / single-name
    // tables — we only validate against catalog-resolvable bases.
    const aliasMap = new Map<string, AliasBinding>()
    const fromJoinRe = /\b(?:FROM|JOIN)\s+\[?(\w+)\]?\.\[?(\w+)\]?(?:\s+(?:AS\s+)?\[?(\w+)\]?)?/gi
    let fm: RegExpExecArray | null
    while ((fm = fromJoinRe.exec(stmt)) !== null) {
      const schema = fm[1]
      const table = fm[2]
      const aliasRaw = fm[3]
      const qualified = `${schema}.${table}`
      const catalogTable = catalog.getTable(qualified)
      if (!catalogTable) continue   // Not in catalog → cannot validate; stay silent.

      // Effective alias: explicit alias if given AND not a reserved keyword
      // (otherwise it's our regex eating the next clause: `FROM x.y WHERE` →
      // `aliasRaw=WHERE`). Fall back to bare table name.
      const candidate = aliasRaw && !reservedAliases.has(aliasRaw.toLowerCase())
        ? aliasRaw
        : table
      aliasMap.set(candidate.toLowerCase(), { alias: candidate, qualifiedTable: qualified })
    }

    if (aliasMap.size === 0) continue

    // Validate qualified column references.
    //  - 2-part: `alias.col` (most common in the wild)
    //  - 3-part: `schema.table.col`
    // We require the trailing char NOT to be `(` (else it's a function call).
    const refRe = /\b\[?(\w+)\]?\.\[?(\w+)\]?(?:\.\[?(\w+)\]?)?/g
    let rm: RegExpExecArray | null
    while ((rm = refRe.exec(stmt)) !== null) {
      const a = rm[1]
      const b = rm[2]
      const c = rm[3]
      // Trailing `(` → function call (e.g. `dbo.fnFoo(...)`, `r.ToString()`).
      const after = stmt.charAt(rm.index + rm[0].length)
      if (after === "(") continue

      let table: string
      let column: string
      let referenceText: string
      if (c) {
        // 3-part `schema.table.col`
        const qualified = `${a}.${b}`
        const tbl = catalog.getTable(qualified)
        if (!tbl) continue   // Unknown schema.table → can't claim "invented".
        table = qualified
        column = c
        referenceText = `${a}.${b}.${c}`
      } else {
        // 2-part `alias.col`
        const aliasLower = a.toLowerCase()
        if (reservedAliases.has(aliasLower)) continue
        const binding = aliasMap.get(aliasLower)
        if (!binding) continue   // Unknown alias → silent.
        if (NON_COLUMN_TOKEN.has(b.toLowerCase())) continue
        // `alias.*` is whitespace by now; the regex won't match `*` anyway.
        table = binding.qualifiedTable
        column = b
        referenceText = `${binding.alias}.${b}`
      }

      const catalogTable = catalog.getTable(table)
      if (!catalogTable) continue
      const colLower = column.toLowerCase()
      const exists = catalogTable.columns.some((cc) => cc.name.toLowerCase() === colLower)
      if (exists) continue

      const key = `${table}::${colLower}`
      if (seen.has(key)) continue
      seen.add(key)
      offenders.push({
        reference: referenceText,
        table,
        column,
        suggestions: nearestColumns(column, catalogTable.columns),
      })
    }
  }
  return offenders
}

// ── Lineage branch-coverage advisor (Phase 2) ────────────────────
//
// Doctrine: `publish.Revenue` is a UNION ALL over ~59 source-mapping views
// (branches). A query that ranks clients from a #temp built from only 3
// of those branches, then reports back against the full `publish.Revenue`
// view, produces a ranking-universe ≠ reporting-universe mismatch — observed
// in trace 2026-05-21T20-32-25 where stage-1 used 3 branches and stage-2
// pulled from the full view, yielding an ~11× revenue understatement on the
// top client. Soft-warn (not block): branch sub-sampling is sometimes
// intentional — but it must be explicit.
//
// Escape comment (case-insensitive substring match): `-- sampled K of N`,
// `-- branches:` followed by an explicit list, or `-- branch-sample`.

interface BranchCatalogLike {
  getUnionParents(qualifiedName: string): string[]
  getUnionBranches(qualifiedName: string): string[]
}

export interface BranchCoverageGap {
  /** Parent view that the referenced branches roll up to, e.g. "publish.Revenue". */
  parent: string
  /** Branches the query actually references (qualified names). */
  referenced: string[]
  /** Total branch count for the parent according to lineage. */
  totalBranches: number
}

const EMPTY_BRANCH_ACCESSOR = (): BranchCatalogLike | null => null

const BRANCH_SAMPLE_COMMENT = /--\s*(sampled\s+\d+\s+of\s+\d+|branches?\s*:|branch-sample)/i

/**
 * Detect view-UNION branch-coverage gaps: queries that reference ≥2 base
 * tables that feed the same big UNION view, but cover fewer than the
 * view's full branch set, without an explicit `-- sampled K of N`
 * annotation.
 *
 * Conservative: a single-branch reference is treated as intentional;
 * gaps are only reported when the model has clearly started branch-by-
 * branch staging but stopped short of full coverage.
 */
export function detectLineageBranchCoverage(
  query: string,
  accessor: () => BranchCatalogLike | null = EMPTY_BRANCH_ACCESSOR,
): BranchCoverageGap[] {
  if (BRANCH_SAMPLE_COMMENT.test(query)) return []

  const catalog = accessor()
  if (!catalog) return []

  const stripped = stripForScan(query).replace(/\bWITH\s*\([^)]*\)/gi, " ")

  // Extract every schema.table reference in FROM/JOIN positions.
  const tableRefRe = /\b(?:FROM|JOIN)\s+\[?(\w+)\]?\.\[?(\w+)\]?/gi
  const referencedBranches = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = tableRefRe.exec(stripped)) !== null) {
    referencedBranches.add(`${m[1]}.${m[2]}`)
  }

  // Group referenced tables by UNION parent view.
  const parentMap = new Map<string, Set<string>>()
  for (const qn of referencedBranches) {
    const parents = catalog.getUnionParents(qn)
    for (const parent of parents) {
      let set = parentMap.get(parent)
      if (!set) {
        set = new Set<string>()
        parentMap.set(parent, set)
      }
      set.add(qn)
    }
  }

  const gaps: BranchCoverageGap[] = []
  for (const [parent, refs] of parentMap.entries()) {
    if (refs.size < 2) continue // single-branch is treated as intentional
    const branches = catalog.getUnionBranches(parent)
    const total = branches.length
    if (total === 0) continue
    if (refs.size >= total) continue // full coverage
    gaps.push({
      parent,
      referenced: [...refs].sort(),
      totalBranches: total,
    })
  }
  return gaps.sort((a, b) => a.parent.localeCompare(b.parent))
}

// ── Big-view profile_data nudge — REMOVED 2026-05-21 ─────────────
//
// Previous iteration of this module exported `detectBigViewWithoutProfile`
// which warned the agent to call `profile_data` on every large view
// before any analytical query. That advice was actively harmful:
// profile_data runs unfiltered COUNT_BIG(*) + per-column NULL/DISTINCT/TOP-N
// aggregates which scan every branch of a UNION view and time out at 60s.
// The correct fix is to refuse the operation at the profile_data tool itself
// (see `isLargeObject` guard in mssql-profiler.ts) and let the validator's
// existing `isUnsafeScan` continue to handle unfiltered query_mssql scans.

/**
 * @deprecated Always returns []. Profile-first guidance is now enforced
 * by refusing profile_data on large objects, not by warning on query_mssql.
 */
export function detectBigViewWithoutProfile(
  _query: string,
  _profiledTables: ReadonlySet<string> | null,
): string[] {
  return []
}

function liveProfiledTables(): ReadonlySet<string> | null {
  return null
}

export interface QueryValidationOptions {
  accessor?: CatalogAccessor
  profiledTables?: ReadonlySet<string> | null
}

// ── Cross-source reconciliation guard (Phase 5) ──────────────────
//
// Trace 2026-05-21 showed the agent ranking from a `#temp` derived from a
// 3-branch subset, then joining a wide UNION view that covers all
// branches to "enrich" the aggregate — silently mixing two universes.
// The reported SUM was correct for the SQL but wrong for the user's
// intent.
//
// Soft-warn (not block) when:
//   - query references both a `#temp` table AND a wide-UNION view
//     (per catalog), AND
//   - the SELECT list contains an aggregate (SUM/COUNT/AVG/MIN/MAX), AND
//   - the escape comment `-- universes intentional` is absent.
//
// The advisory is informational; aggregating across mixed universes is
// sometimes the right thing. The escape comment makes intent explicit.

const UNIVERSES_INTENTIONAL_COMMENT = /--\s*universes\s+intentional/i
const TEMP_TABLE_REF = /(?:^|\s)#\w+/
const AGGREGATE_IN_SELECT = /\b(?:sum|count|avg|min|max)\s*\(/i

export interface RankingReportingMismatch {
  readonly tempTouched: boolean
  readonly bigViews: string[]
}

export function detectRankingVsReportingMismatch(query: string, accessor?: CatalogAccessor): RankingReportingMismatch | null {
  if (UNIVERSES_INTENTIONAL_COMMENT.test(query)) return null
  const stripped = query
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
  if (!TEMP_TABLE_REF.test(stripped)) return null
  if (!AGGREGATE_IN_SELECT.test(stripped)) return null
  const tc = getTenantConfig()
  const bigViews = referencedLargeObjects(query, accessor).filter((r) =>
    isExpensiveUnionView(r, { accessor, threshold: tc.unionBranchThreshold }),
  )
  if (bigViews.length === 0) return null
  return { tempTouched: true, bigViews }
}

export function analyzeMssqlQueryQuality(query: string, accessor?: CatalogAccessor): MssqlQueryQualityAnalysis {
  const largeObjectRefs = Array.from(countReferencedLargeObjects(query, accessor).entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const temp = analyzeTempTableBatch(query)
  const aggregateIssues = findAggregateSemanticIssues(query)

  // Mirror analysis: "persisted mirror" is a tenant-configured naming
  // convention (config.mirrorSchema). When set, any reference of shape
  // `<mirrorSchema>.<x>` counts as "using the mirror", and any large
  // base object whose mirror EXISTS in the catalog but isn't referenced
  // becomes a `missingPersistedMirrorCandidates` entry.
  const mirrorSchema = getTenantConfig().mirrorSchema
  const usesPersistedMirrors = mirrorSchema
    ? largeObjectRefs.map((e) => e.name).filter((n) => n.startsWith(`${mirrorSchema.toLowerCase()}.`))
    : []
  const missingPersistedMirrorCandidates: string[] = []
  if (mirrorSchema) {
    for (const ref of largeObjectRefs) {
      // Skip if the ref IS itself a mirror.
      if (ref.name.startsWith(`${mirrorSchema.toLowerCase()}.`)) continue
      // persistedMirrorOf does case-insensitive catalog lookup internally.
      const mirror = persistedMirrorOf(ref.name, { accessor, mirrorSchema })
      if (!mirror) continue
      const mirrorKey = mirror.toLowerCase()
      if (!usesPersistedMirrors.includes(mirrorKey)) missingPersistedMirrorCandidates.push(ref.name)
    }
  }

  const hasWhere = hasWhereClause(query)
  const unsafeScanReason = isUnsafeScan(query, largeObjectRefs.map((entry) => entry.name))
  return {
    largeObjectRefs,
    usesPersistedMirrors,
    missingPersistedMirrorCandidates,
    hasWhereClause: hasWhere,
    unsafeScanReason,
    tempTableRefs: temp.refs.length,
    tempTablesCreated: temp.created.length,
    tempTableSuffixes: temp.suffixes,
    malformedTempSuffixes: temp.malformedSuffixes,
    missingTempCreations: temp.missingCreations,
    aggregateWarningCount: aggregateIssues.filter((issue) => issue.severity === AggregateSeverity.Warn).length,
    aggregateBlockCount: aggregateIssues.filter((issue) => issue.severity === AggregateSeverity.Block).length,
    tempScalarSubqueryCount: countTempScalarSubqueries(query),
    stagePatternLikely:
      largeObjectRefs.length > 0 &&
      largeObjectRefs.every((entry) => entry.count <= 2) &&
      temp.created.length > 0,
  }
}

function extractLocalTempRefs(query: string): string[] {
  const stripped = stripForScan(query)
  const refs: string[] = []
  const re = /##?[A-Za-z_][\w]*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const name = m[0]
    if (name.startsWith("##")) continue
    if (!refs.includes(name)) refs.push(name)
  }
  return refs
}

function extractCreatedLocalTemps(query: string): string[] {
  const stripped = stripForScan(query)
  const created: string[] = []
  const patterns = [
    /\bCREATE\s+TABLE\s+(#[A-Za-z_][\w]*)/gi,
    /\bSELECT\b[\s\S]*?\bINTO\s+(#[A-Za-z_][\w]*)\s+FROM\b/gi,
  ]
  for (const re of patterns) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const name = m[1]
      if (!created.includes(name)) created.push(name)
    }
  }
  return created
}

export function validateTempTableBatch(query: string): string | null {
  const temp = analyzeTempTableBatch(query)
  if (temp.refs.length === 0) return null

  const malformedSuffixTemps = temp.malformedSuffixes
  if (malformedSuffixTemps.length > 0) {
    return [
      `Query blocked — malformed #temp suffix (expected 8 hex chars): ${malformedSuffixTemps.join(", ")}.`,
      ``,
      `Use names like \`#range_a3f91c08\` and reuse that exact 8-hex suffix across the whole batch.`,
    ].join("\n")
  }

  if (temp.created.length > 0) {
    if (temp.missingCreations.length > 0) {
      return [
        `Query blocked — local #temp table referenced without being created in the same batch: ${temp.missingCreations.join(", ")}.`,
        ``,
        `This usually means a typo or suffix drift (for example one reference says \`#balLines_ab12cd34\` and another says \`#balLines_ab12dc34\`).`,
        `In pooled connections, assuming a #temp from a prior call still exists is unsafe. Create every #temp in the same batch that reads it, then DROP it at the end.`,
      ].join("\n")
    }
  }

  if (temp.suffixes.length > 1) {
    return [
      `Query blocked — inconsistent #temp suffixes in one batch: ${temp.suffixes.join(", ")}.`,
      ``,
      `Use exactly one 8-hex suffix across every local #temp in the batch so references cannot drift by one character.`,
      `Pattern: pick one suffix once (for example \`a3f91c08\`) and reuse it literally in every #temp, index name and DROP statement.`,
    ].join("\n")
  }

  return null
}

/**
 * Returns true if the query has a meaningful WHERE clause (not inside a subquery
 * that only applies to some unrelated CTE/table).
 * This is a conservative check — it only looks for the presence of WHERE at the
 * outer query level. A false negative (WHERE is inside a subquery only) is fine
 * because we'd rather block too aggressively than allow a full scan.
 */
export function hasWhereClause(query: string): boolean {
  const stripped = query
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/'[^']*'/g, "''")  // remove string literals that might contain WHERE
  return /\bWHERE\b/i.test(stripped)
}

/**
 * Returns true if the query selects from a large object but the only TOP/ORDER BY
 * without a WHERE is a "SELECT TOP N ... ORDER BY col" pattern that forces a full scan
 * to find the globally sorted top-N.
 *
 * Safe patterns (not blocked):
 *   SELECT TOP N ... FROM large_table WHERE ...   ← WHERE present, fine
 *   SELECT MIN/MAX FROM dim.Date                  ← dim.Date is small
 *
 * Blocked patterns:
 *   SELECT TOP N ... FROM large_view ORDER BY col    ← full scan to sort
 *   SELECT TOP N ... FROM large_view                 ← unfiltered
 *   SELECT MIN(col) FROM large_view                  ← full scan aggregate
 *   SELECT COUNT(*) FROM large_view                  ← full scan aggregate
 *   SELECT DISTINCT col FROM large_view              ← full scan
 */
export function isUnsafeScan(query: string, largeObjects: string[]): string | null {
  if (largeObjects.length === 0) return null
  if (hasWhereClause(query)) return null

  const stripped = query.replace(/--[^\r\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")

  // Detect COUNT(*), MIN(), MAX(), SUM(), AVG() without WHERE — full scan aggregate
  if (/\b(COUNT|MIN|MAX|SUM|AVG)\s*\(/i.test(stripped)) {
    return `full-scan aggregate`
  }

  // Detect DISTINCT without WHERE
  if (/\bSELECT\s+DISTINCT\b/i.test(stripped)) {
    return `DISTINCT without WHERE`
  }

  // Unfiltered scan (no WHERE at all on a large object)
  return `no WHERE clause`
}

export function validateQuery(
  query: string,
  writeEnabled: boolean,
  options: QueryValidationOptions = {},
): string | null {
  return validateQueryDetailed(query, writeEnabled, options).error
}

export function validateQueryDetailed(
  query: string,
  writeEnabled: boolean,
  options: QueryValidationOptions = {},
): QueryValidationDiagnostics {
  const analysis = analyzeMssqlQueryQuality(query, options.accessor)
  // Always block dangerous operations regardless of write mode — must run BEFORE
  // the write-mode gate so that EXEC / OPENROWSET / DBCC produce the dangerous
  // error message instead of the generic "write disabled" one.
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(query)) {
      return {
        ok: false,
        error: "Query blocked: contains potentially dangerous operation (EXEC, xp_, OPENROWSET, BULK INSERT, DBCC, SHUTDOWN, etc.).",
        code: "dangerous_operation",
        analysis,
      }
    }
  }

  // ── Aggregate-semantic guard (block-level only) ─────────────
  // Catches the most dangerous correctness bug we've seen in the wild:
  // `SUM(<col>) AS Avg…` — the aggregate function and the output alias
  // semantically disagree, so the result is N× the real average and the
  // controller has no way of knowing the number is wrong. See
  // findAggregateSemanticIssues() for the full taxonomy and rationale.
  for (const issue of findAggregateSemanticIssues(query)) {
    if (issue.severity !== AggregateSeverity.Block) continue
    const head = [
      `Query blocked — aggregate-semantic mismatch on line ${issue.line}:`,
      ``,
      `    ${issue.snippet}`,
      ``,
      issue.message,
    ].join("\n")
    return {
      ok: false,
      error: withFixHint(head, "aggregate_semantic_mismatch"),
      code: "aggregate_semantic_mismatch",
      analysis,
      lesson: getDoctrineLessonTemplate("aggregate_semantic_mismatch")?.({
        query,
        detail: issue.snippet,
      }) ?? null,
    }
  }

  const tempBatchError = validateTempTableBatch(query)
  if (tempBatchError) {
    return {
      ok: false,
      error: withFixHint(tempBatchError, "temp_table_integrity"),
      code: "temp_table_integrity",
      analysis,
      lesson: getDoctrineLessonTemplate("temp_table_integrity")?.({
        query,
        detail: tempBatchError.split("\n")[0],
      }) ?? null,
    }
  }

  const tempScalarCounts = countTempScalarSubqueriesByTemp(query)
  const repeatedTempScalarProbes = Array.from(tempScalarCounts.entries()).filter(([, count]) => count > 1)
  if (repeatedTempScalarProbes.length > 0) {
    const list = repeatedTempScalarProbes.map(([name, count]) => `${name} (${count} scalar probes)`).join(", ")
    const head = [
      `Query blocked — repeated scalar subqueries against staged #temp data: ${list}.`,
      ``,
      `This shape repeatedly re-probes staged rows one metric at a time and is exactly the pattern that turns a good micro-ETL into a slow Stage 3 plan.`,
    ].join("\n")
    return {
      ok: false,
      error: withFixHint(head, "temp_scalar_subquery_overused"),
      code: "temp_scalar_subquery_overused",
      analysis,
      lesson: getDoctrineLessonTemplate("temp_scalar_subquery_overused")?.({
        query,
        detail: list,
      }) ?? null,
    }
  }

  // Block direct top-N + GROUP BY <high-card key> against any wide UNION view
  // the catalog classifies as expensive (≥ tenantConfig.unionBranchThreshold
  // branches). The fix is per-branch aggregation — see doctrine
  // `mssql.wide-union-view-policy`.
  const wideUnionOffender = detectWideUnionViewTopnWithoutBranchAggregation(query, { accessor: options.accessor })
  if (wideUnionOffender) {
    const head = [
      `Query blocked — direct TOP-N + GROUP BY ${wideUnionOffender.groupKey} against ${wideUnionOffender.object}.`,
      ``,
      `${wideUnionOffender.object} is a UNION ALL over ${wideUnionOffender.branchCount} source-mapping views (per live catalog). A single GROUP BY ${wideUnionOffender.groupKey} + TOP N forces SQL Server to expand every branch, materialise the lot, then group and sort globally. No branch-local index can help — this shape runs for minutes and is the canonical cause of cancelled runs on wide UNION views.`,
    ].join("\n")
    return {
      ok: false,
      error: withFixHint(head, "publish_view_topn_without_branch_aggregation"),
      code: "publish_view_topn_without_branch_aggregation",
      analysis,
      lesson: getDoctrineLessonTemplate("publish_view_topn_without_branch_aggregation")?.({
        query,
        detail: `${wideUnionOffender.object} GROUP BY ${wideUnionOffender.groupKey}`,
      }) ?? null,
    }
  }

  // Block AVG(COALESCE/ISNULL(col, 0)) — silently understates true average.
  const avgCoalesceOffenders = detectAvgOfCoalesceZero(query)
  if (avgCoalesceOffenders.length > 0) {
    const list = avgCoalesceOffenders.map((o) => o.snippet).join("; ")
    const head = [
      `Query blocked — statistical mistake: ${list}.`,
      ``,
      `Wrapping NULL in COALESCE(..., 0) inside AVG treats a missing observation as an observed zero — it drags the reported average down and the controller has no way to detect it from the result. T-SQL AVG already skips NULLs.`,
    ].join("\n")
    return {
      ok: false,
      error: withFixHint(head, "avg_of_coalesce_zero"),
      code: "avg_of_coalesce_zero",
      analysis,
      lesson: getDoctrineLessonTemplate("avg_of_coalesce_zero")?.({
        query,
        detail: avgCoalesceOffenders[0].snippet,
      }) ?? null,
    }
  }

  // Block references to columns that do not exist on the catalog table the
  // alias resolves to. Only fires when (a) a live catalog is loaded and
  // (b) the alias provenance is unambiguous (no CTE/derived/UNION). Catches
  // hallucinated columns like `r.ClientName`, `publish.Officer.fullName`.
  const inventedColumns = detectInventedColumns(query, options.accessor ?? EMPTY_CATALOG_ACCESSOR)
  if (inventedColumns.length > 0) {
    const lines = inventedColumns.slice(0, 5).map((o) => {
      const hint = o.suggestions.length > 0 ? `  (closest live columns on ${o.table}: ${o.suggestions.join(", ")})` : ""
      return `  - ${o.reference} → column "${o.column}" not in ${o.table}${hint}`
    })
    const more = inventedColumns.length > 5 ? `\n  …and ${inventedColumns.length - 5} more.` : ""
    const head = [
      `Query blocked — references columns that do not exist in the live catalog:`,
      lines.join("\n") + more,
      ``,
      `The catalog is the live sys.all_columns snapshot for this connection. If the column truly exists, the catalog is stale — call \`refresh_catalog\` and retry. Otherwise the column is hallucinated; use \`search_catalog\` to confirm names before writing SQL.`,
    ].join("\n")
    const first = inventedColumns[0]
    return {
      ok: false,
      error: withFixHint(head, "invented_column"),
      code: "invented_column",
      analysis,
      lesson: getDoctrineLessonTemplate("invented_column")?.({
        query,
        detail: `${first.table}.${first.column}`,
      }) ?? null,
    }
  }

  if (!writeEnabled) {
    // Two valid shapes when write is disabled:
    //   1. Pure read query (SELECT/WITH/EXPLAIN/...)
    //   2. Micro-ETL batch where every mutation targets a local #temp table.
    //      The agent is encouraged to stage small slices into #tmp tables and
    //      join those against the big warehouse views — see default-system.md
    //      "Big-table query discipline".
    const isPureRead = READ_ONLY_PATTERN.test(query)
    const opensWithMutation = TMP_TABLE_OPENER.test(query)
    if (!isPureRead && !opensWithMutation) {
      return {
        ok: false,
        error: "Write operations are disabled. Only SELECT/WITH queries are allowed (or DDL/DML targeting local #temp tables only).",
        code: "write_disabled",
        analysis,
      }
    }
    if (opensWithMutation) {
      const offenders = findNonTmpMutations(query)
      if (offenders.length > 0) {
        const list = offenders.map((o) => `${o.label} ${o.target}`).join(", ")
        return {
          ok: false,
          error: [
            `Query blocked: write operation against non-temp object(s): ${list}.`,
            ``,
            `You may only CREATE / INSERT / UPDATE / DELETE / DROP / TRUNCATE / MERGE / SELECT INTO `,
            `against LOCAL #temp tables (names starting with a single '#'). Existing schema-qualified `,
            `tables, views, indexes and global ##temp tables are READ-ONLY.`,
            ``,
            `Pattern: stage a narrow slice into #scope, optionally CREATE INDEX on its keys, then join `,
            `the big warehouse view to #scope. DROP TABLE #scope at the end.`,
          ].join("\n"),
          code: "non_temp_mutation",
          analysis,
        }
      }
    }
  }

  const largeRefCounts = countReferencedLargeObjects(query, options.accessor)
  const overusedLargeObjects = Array.from(largeRefCounts.entries()).filter(([, count]) => count > 2)
  if (overusedLargeObjects.length > 0) {
    const list = overusedLargeObjects.map(([name, count]) => `${name} (${count} references)`).join(", ")
    return {
      ok: false,
      error: [
        `Query blocked — large object referenced too many times in one batch: ${list}.`,
        ``,
        `Large publish views and their persisted mirrors still represent very large scans. Referencing one more than twice usually means the query will rescan the warehouse slice and miss the 2-minute budget.`,
        `Required fix: Stage keys on the first touch, fetch detail rows on the second touch, then derive every remaining metric from #temp tables only.`,
      ].join("\n"),
      code: "large_object_overused",
      analysis,
    }
  }

  // ── Scan guard ────────────────────────────────────────────────
  // Block queries that would trigger a full table/view scan on known large objects.
  const largeRefs = referencedLargeObjects(query, options.accessor)
  const scanReason = isUnsafeScan(query, largeRefs)
  if (scanReason) {
    const objects = largeRefs.join(", ")
    return {
      ok: false,
      error: scanGuardErrorMessage(objects, scanReason, largeRefs, options.accessor),
      code: "unsafe_large_object_scan",
      analysis,
    }
  }

  return { ok: true, error: null, code: null, analysis }
}

/**
 * Compose the scan-guard error so the fix-hint uses catalog-derived
 * facts instead of hardcoded customer names: the FIRST large object the
 * query touched picks the example mirror/calendar/date-key. When the
 * catalog can't supply one, the hint falls back to generic shape advice.
 */
function scanGuardErrorMessage(
  objects: string,
  scanReason: string,
  largeRefs: string[],
  accessor?: CatalogAccessor,
): string {
  const tc = getTenantConfig()
  const firstRef = largeRefs[0]
  const catalog = accessor ? accessor() : null
  const firstTable = firstRef && catalog ? catalog.getTable(firstRef) : null
  const firstQn = firstTable?.qualifiedName ?? firstRef ?? "<large-object>"

  const mirror = firstTable && tc.mirrorSchema
    ? persistedMirrorOf(firstTable.qualifiedName, { accessor, mirrorSchema: tc.mirrorSchema })
    : null
  const exampleObject = mirror ?? firstQn
  const dateKey = firstTable ? dateGrainColumn(firstTable.qualifiedName, { accessor }) : null
  const calendar = calendarDimensionTable({ accessor })
  const calendarKey = calendar ? primaryKeyColumns(calendar, { accessor })[0] ?? null : null

  const lines = [
    `Query blocked — would cause a full scan of large object(s): ${objects} (${scanReason}).`,
    ``,
    `Large warehouse views/tables are UNION views or partitioned facts spanning many tables. Use the persisted mirror when available.`,
    `An unfiltered query re-executes the entire scan and will run for minutes / never complete.`,
    ``,
    `Required fix:`,
  ]
  if (calendar && calendarKey && dateKey) {
    lines.push(
      `1. First resolve the date/key range from the small calendar dimension:`,
      `      SELECT MIN(${calendarKey}) AS fromKey, MAX(${calendarKey}) AS toKey FROM ${calendar} WITH (NOLOCK) WHERE <date-predicate>`,
      `2. Then query the large object WITH a WHERE predicate that narrows the scan:`,
      `      SELECT ... FROM ${exampleObject} WITH (NOLOCK) WHERE ${dateKey} BETWEEN <fromKey> AND <toKey> GROUP BY ...`,
    )
  } else if (dateKey) {
    lines.push(
      `1. Add a narrowing predicate on the time-grain column \`${dateKey}\` (the catalog's FK to your calendar dimension).`,
      `2. Then query the large object: SELECT ... FROM ${exampleObject} WITH (NOLOCK) WHERE ${dateKey} = <value> GROUP BY ...`,
    )
  } else {
    lines.push(
      `1. Identify a high-selectivity column on ${firstQn} (PK, FK to a small dim, or a date column) and add a WHERE predicate on it.`,
      `2. Then query: SELECT ... FROM ${exampleObject} WITH (NOLOCK) WHERE <predicate> GROUP BY ...`,
    )
  }
  lines.push(
    `3. Add WITH (NOLOCK) for read-only analytical queries.`,
    `4. Never use ORDER BY without WHERE on a large view — it forces a full sort of all rows.`,
    `5. If checking what data exists: query sys.partitions or the calendar dim — NOT the view itself.`,
  )
  return lines.join("\n")
}

// ── Aggregate-semantic guard ─────────────────────────────────
//
// Why this exists (the bug it prevents):
//   The agent has been observed writing queries like
//       OUTER APPLY (
//         SELECT SUM(b.AverageCreditBalanceZARMTD) AS AvgCreditBalZAR …
//       )
//   The output column name says "Avg" but the aggregate is SUM. Summing
//   12 monthly averages returns 12× the real average — and the user has
//   no way to detect it from the result alone (the number is plausible).
//   The SQL engine cannot catch this; only a semantic-aware guard can.
//
// Two-tier defence:
//   • "block"  — the function family and the alias family DISAGREE
//                (SUM(...) AS Avg…, AVG(...) AS Total…, MIN(...) AS Max…,
//                COUNT(...) AS Avg…). Near-zero false positives — it is
//                always either a function bug or an alias lie. We refuse.
//   • "warn"   — the function is SUM-like and the source-column name
//                contains a "pre-aggregated" token (Average/Mean/Median/
//                Spot/EOM/Eod/Latest/Snapshot/EndOf*/StartOf*). The alias
//                may be honest ("SumOfMonthlyAvgs"); the engine can't
//                know the user's intent. We surface the warning in the
//                result text so the agent re-considers without blocking
//                the legitimate edge case.
//
// Implementation: regex-driven, balanced-paren-aware over a stripped copy
// (comments + string literals removed). Handles single-level nesting like
// SUM(ISNULL(col, 0)), SUM(CAST(col AS int)), AVG(a + b) — sufficient for
// the typical bug shape. Multi-level nested aggregates (e.g. SUM(AVG(x)))
// are valid SQL only inside windowed/grouped contexts and rare; we focus
// on the high-impact single-level case.

export type AggregateSemanticIssue = {
  severity: AggregateSeverity
  line:     number   // 1-based
  snippet:  string   // the offending substring (≤80 chars)
  message:  string   // actionable, agent-facing fix hint
}

const AGG_FUNCTION_FAMILIES: { re: RegExp; family: AggregateFamily }[] = [
  { re: /^(SUM|TOTAL)$/i,                     family: AggregateFamily.Sum   },
  { re: /^(AVG|AVERAGE|MEAN)$/i,              family: AggregateFamily.Avg   },
  { re: /^(MIN|MINIMUM)$/i,                   family: AggregateFamily.Min   },
  { re: /^(MAX|MAXIMUM)$/i,                   family: AggregateFamily.Max   },
  { re: /^(COUNT|COUNT_BIG)$/i,               family: AggregateFamily.Count },
]

// Alias-prefix → semantic family. Order matters: more-specific first.
// We check the alias's word-prefix only — `AvgCreditBal_2025` is Avg-family,
// `TotalRevenueZAR` is Sum-family, etc.
const ALIAS_PREFIX_FAMILIES: { re: RegExp; family: AggregateFamily }[] = [
  { re: /^(avg|average|mean|median|mid|middle)/i,                                                    family: AggregateFamily.Avg   },
  { re: /^(sum|total|aggregate|gross|net|grand)/i,                                                   family: AggregateFamily.Sum   },
  { re: /^(min|minimum|earliest|oldest|low|lowest|first)/i,                                          family: AggregateFamily.Min   },
  { re: /^(max|maximum|latest|newest|peak|high|highest|last|spot|eom|eod|snapshot|endof|asof)/i,     family: AggregateFamily.Max   },
  { re: /^(count|cnt|num|number|distinct|n_|nbr)/i,                                                  family: AggregateFamily.Count },
]

// Source-column-name tokens that indicate the column IS ALREADY pre-aggregated.
// Used by the soft-warn rule: SUM-ing one of these almost always returns the
// wrong number (N× the true value). Tokens come from tenant config
// (`preAggregationTokens`); regex is rebuilt when the config or list reference
// changes. Camelcase-aware: matches either at a word boundary
// (`\bAverageCredit…`, `EOMBalance`) OR right after a lowercase letter
// (`MonthlyAvg`, `dailySpot`). We DO NOT require a trailing word boundary —
// `AverageCreditBalanceZARMTD` must trigger on `Average`.
const validationCache = {
  preAggregatedColReCache: null as { tokensRef: object; re: RegExp } | null,
}

function preAggregatedColRe(): RegExp {
  const tokens = getTenantConfig().preAggregationTokens
  if (validationCache.preAggregatedColReCache && validationCache.preAggregatedColReCache.tokensRef === (tokens as unknown as object)) {
    return validationCache.preAggregatedColReCache.re
  }
  const alternation = tokens.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  // Empty tenant config → regex that never matches.
  const re = alternation.length > 0
    ? new RegExp(`(?:\\b|(?<=[a-z]))(${alternation})`, "i")
    : /a^/
  validationCache.preAggregatedColReCache = { tokensRef: tokens as unknown as object, re }
  return re
}

/** Strip comments + string literals while preserving newline positions for line counts. */
function stripForScan(query: string): string {
  return query
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/'[^']*'/g, (m) => `'${" ".repeat(Math.max(0, m.length - 2))}'`)
}

/** Return the line number (1-based) for a character offset in `text`. */
function lineOf(text: string, offset: number): number {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** Walk a balanced-paren block starting at `start` (the index of '('). Returns the index AFTER the matching ')', or -1. */
function findMatchingParen(text: string, start: number): number {
  if (text.charCodeAt(start) !== 40 /* ( */) return -1
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch === 40) depth++
    else if (ch === 41) {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function aliasFamily(alias: string): AggregateFamily | null {
  for (const { re, family } of ALIAS_PREFIX_FAMILIES) if (re.test(alias)) return family
  return null
}

function functionFamily(fnName: string): AggregateFamily | null {
  for (const { re, family } of AGG_FUNCTION_FAMILIES) if (re.test(fnName)) return family
  return null
}

/**
 * Scan a query for aggregate / output-alias / source-column semantic mismatches.
 * Returns an empty array for clean queries.
 *
 * Caller contract:
 *   - "block" issues MUST prevent execution (validateQuery already does this).
 *   - "warn" issues are surfaced in the result text the LLM reads (see
 *     getQueryWarnings) so the agent re-examines its output without losing
 *     the data for legitimate edge cases (e.g. `SUM(AverageCount) AS TotalAvgCount`).
 */
export function findAggregateSemanticIssues(query: string): AggregateSemanticIssue[] {
  const stripped = stripForScan(query)
  const issues: AggregateSemanticIssue[] = []

  // Find every <FN>( occurrence.
  const fnRe = /\b([A-Z_][A-Z0-9_]*)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = fnRe.exec(stripped)) !== null) {
    const fnFamily = functionFamily(m[1])
    if (!fnFamily) continue

    const openIdx  = m.index + m[0].length - 1   // index of '('
    const closeIdx = findMatchingParen(stripped, openIdx)
    if (closeIdx < 0) continue

    const argText = stripped.slice(openIdx + 1, closeIdx - 1)

    // After the closing paren, look for an optional alias:
    //   ) AS aliasName , …
    //   ) aliasName , …
    //   ) aliasName\n
    const tail = stripped.slice(closeIdx, Math.min(closeIdx + 80, stripped.length))
    const aliasMatch = /^\s*(?:AS\s+)?\[?([A-Za-z_][A-Za-z0-9_]*)\]?\s*(?=,|\n|$|FROM\b|WHERE\b|GROUP\b|ORDER\b|HAVING\b|JOIN\b|ON\b|\)|UNION\b)/i.exec(tail)
    const alias = aliasMatch?.[1]

    // ── BLOCK rule: function family vs alias family disagree ──
    if (alias) {
      const aFamily = aliasFamily(alias)
      if (aFamily && aFamily !== fnFamily) {
        // Special case: COUNT(...) AS Total… is a common, legitimate phrasing
        // ("TotalRows", "TotalCount") — don't block COUNT→sum mismatch.
        const isBenignCountTotal = fnFamily === AggregateFamily.Count && aFamily === AggregateFamily.Sum
        if (!isBenignCountTotal) {
          const snippet = stripped.slice(m.index, Math.min(closeIdx + (aliasMatch?.[0].length ?? 0), m.index + 80))
          issues.push({
            severity: AggregateSeverity.Block,
            line:     lineOf(stripped, m.index),
            snippet:  snippet.replace(/\s+/g, " ").trim(),
            message:  `Function \`${m[1].toUpperCase()}\` (family: ${fnFamily}) is aliased as \`${alias}\` (family: ${aFamily}). One of them is wrong — they describe different operations.`,
          })
          continue   // don't also warn on the same call
        }
      }
    }

    // ── WARN rule: SUM-like applied to a pre-aggregated column name ──
    if (fnFamily === AggregateFamily.Sum) {
      const colMatch = preAggregatedColRe().exec(argText)
      if (colMatch) {
        // Suppress the warning if the alias EXPLICITLY acknowledges that this is
        // a sum of pre-aggregated values — e.g. `SumOfMonthlyAverages`,
        // `TotalAvgCount`, `GrossAvgFooSummed`. The alias-family check already
        // confirmed function and alias are both sum-like (otherwise we'd have
        // hit the BLOCK rule above), so an alias whose family is Sum means
        // the agent has consciously chosen to sum a pre-aggregated value.
        const aliasIsExplicitSum = alias && aliasFamily(alias) === AggregateFamily.Sum
        if (aliasIsExplicitSum) continue
        const snippet = stripped.slice(m.index, Math.min(closeIdx, m.index + 80))
        issues.push({
          severity: AggregateSeverity.Warn,
          line:     lineOf(stripped, m.index),
          snippet:  snippet.replace(/\s+/g, " ").trim(),
          message:  `\`${m[1].toUpperCase()}\` is being applied to a column whose name suggests it is already pre-aggregated (token: \`${colMatch[0]}\`). Summing N pre-averaged or point-in-time values usually returns N× the real value. Did you mean \`AVG(...)\` (for averages) or the \`MAX(pkMonth)\` row's value (for "latest spot")? If the SUM is intentional, alias the output explicitly with a sum-prefixed name (e.g. \`SumOfMonthlyAverages\`, \`TotalAvgFoo\`) and the warning will be suppressed.`,
        })
      }
    }
  }
  return issues
}

/**
 * Format the warn-level issues from findAggregateSemanticIssues as a banner
 * to be prepended to the query result text the LLM reads. Returns null if
 * there are no warnings (don't pollute clean output).
 *
 * The banner is intentionally loud — the agent has been observed skipping
 * subtle hints. Bug-equivalence with a controller spotting it on review is
 * the bar.
 */
export interface QueryWarningOptions {
  accessor?: CatalogAccessor
  branchAccessor?: () => BranchCatalogLike | null
  /** @deprecated alias for branchAccessor */
  lineageAccessor?: () => BranchCatalogLike | null
  /** Per-run set of lowercased schema.table names already profiled. */
  profiledTables?: ReadonlySet<string> | null
}

export function getQueryWarnings(
  query: string,
  options: QueryWarningOptions | (() => BranchCatalogLike | null) = {},
): string | null {
  // Back-compat: a bare accessor function is still accepted.
  const opts: QueryWarningOptions = typeof options === "function"
    ? { branchAccessor: options }
    : options
  const branchAccessor = opts.branchAccessor ?? opts.lineageAccessor ?? EMPTY_BRANCH_ACCESSOR
  const profiledTables = opts.profiledTables ?? liveProfiledTables()
  const rankingAccessor = opts.accessor ?? EMPTY_CATALOG_ACCESSOR

  const warns = findAggregateSemanticIssues(query).filter((i) => i.severity === AggregateSeverity.Warn)
  const branchGaps = detectLineageBranchCoverage(query, branchAccessor)
  const profileTriggers = detectBigViewWithoutProfile(query, profiledTables)
  const mixedUniverses = detectRankingVsReportingMismatch(query, rankingAccessor)
  if (
    warns.length === 0
    && branchGaps.length === 0
    && profileTriggers.length === 0
    && !mixedUniverses
  ) return null

  const lines = [
    `⚠ SQL CORRECTNESS WARNING — review BEFORE trusting the numbers below:`,
    ``,
  ]
  for (const w of warns) {
    lines.push(`  • line ${w.line}: ${w.snippet}`)
    lines.push(`    ${w.message}`)
    lines.push(``)
  }
  for (const gap of branchGaps) {
    lines.push(`  • lineage coverage: ${gap.parent} has ${gap.totalBranches} source branches; this query references only ${gap.referenced.length} of them`)
    lines.push(`    Referenced: ${gap.referenced.join(", ")}`)
    lines.push(`    If the ranking and the final reporting both pull from ${gap.parent}, the unreferenced branches will inflate the reporting metric vs the ranking metric.`)
    lines.push(`    Fix: either rank from the full ${gap.parent} (use the branch-aggregation pattern from the doctrine), or add an explicit \`-- sampled K of N\` comment to confirm the sub-sample is intentional.`)
    lines.push(``)
  }
  for (const view of profileTriggers) {
    lines.push(`  • profile-first: ${view} is a canonical big view and has not been profiled in this run`)
    lines.push(`    Call \`profile_data table='${view}'\` (with a narrow \`columns\` list) BEFORE the analytical pass so you know its row count, NULL rates, and key cardinality. Skip this step and the next query may run for minutes or return a misleading row.`)
    lines.push(``)
  }
  if (mixedUniverses) {
    lines.push(`  • universe mismatch: this query aggregates across a #temp table AND ${mixedUniverses.bigViews.join(", ")}`)
    lines.push(`    The #temp was likely derived from a sub-set (specific branches, months, or clients). Joining ${mixedUniverses.bigViews.join("/")} unfiltered then SUM/COUNT will report the BIG-view universe, not the #temp universe — even though rows appear filtered.`)
    lines.push(`    Fix: either (a) derive the aggregate from a single source, (b) filter ${mixedUniverses.bigViews[0]} by the same predicates that built the #temp, or (c) add \`-- universes intentional\` to acknowledge the cross-universe aggregate.`)
    lines.push(``)
  }
  if (warns.length > 0) {
    lines.push(`If the warning is a false positive, re-run the query with an explicit alias that names the operation (e.g. \`SumOfMonthlyAverages\`) — the result will be returned without re-flagging.`)
  }
  lines.push(`---`)
  return lines.join("\n")
}

