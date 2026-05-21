// ── Query validation ─────────────────────────────────────────────

import { DOCTRINE_FIX_HINTS } from "../../doctrine/fix-hints.js"
import { AggregateFamily, AggregateSeverity } from "../../domain/enums/sql-guard.js"

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
// Any table or view in this list will be checked for the absence of
// a WHERE clause before the query is executed. An unfiltered query
// against these objects will time out or run for minutes — it must be
// blocked at the tool level regardless of what the LLM produces.
//
// Format: lowercased "schema.object" strings.
// Covers both the base view and its persistedView mirror.
const LARGE_OBJECTS = new Set([
  // publish views — each is a UNION of 10–60 large fact tables
  "publish.revenue",
  "publish.balances",
  "persistedview.publish.revenue",
  "persistedview.publish.balances",
  "publish.clientprofitability",
  "publish.financialdisclosurerules",
  "publish.africasalescredittradesrules",
  "publish.rwa",
  "publish.impairment",
  // large fact tables
  "fact.unotranspose",
  "fact.imexcommissionsdealbalance",
  "fact.africaflexdailybalances",
  "fact.financialdisclosuredaily",
  "fact.financialdisclosuredailysap",
  "fact.backdatedtransactions",
  "fact.counterpartystructures",
  "fact.acmaccountfacilitymapping",
  "fact.acmfacility",
  "fact.pnlrevenuemtd",
  "fact.africafrontarena",
  "fact.merchantservices",
  // large dim tables
  "dim.account",
  "dim.client",
  // large ext tables
  "ext.ghanadailyaccountsall",
  "ext.botswana dailyaccountsall",
  "ext.zambiadailyaccountsall",
  "ext.africaflexdailybalanceskenyacasa",
  // large log/agent tables
  "log.detail",
  "agent.activityrun",
  "agent.activityrunarchive",
])

/**
 * Returns the set of large schema.object names referenced in the query (lowercased).
 * Handles: schema.table, [schema].[table], schema.[table], "schema"."table"
 */
export function referencedLargeObjects(query: string): string[] {
  // Strip comments first
  const stripped = query
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")

  const found: string[] = []
  // Match schema.object in various bracket/quote forms.
  const re = /\[?(\w+)\]?\.\[?(\w+)\]?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`
    if (LARGE_OBJECTS.has(key) && !found.includes(key)) {
      found.push(key)
    }
  }
  // Match persistedView.[publish.Revenue] style 2-part references where the
  // object name itself contains a dot.
  const persistedBracketedRe = /\[?(persistedview)\]?\.\[?(publish\.(?:revenue|balances))\]?/gi
  while ((m = persistedBracketedRe.exec(stripped)) !== null) {
    const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`
    if (LARGE_OBJECTS.has(key) && !found.includes(key)) found.push(key)
  }
  return found
}

/** Returns per-object reference counts for known large objects. */
export function countReferencedLargeObjects(query: string): Map<string, number> {
  const stripped = query
    .replace(/--[^\r\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")

  const counts = new Map<string, number>()
  const re = /\[?(\w+)\]?\.\[?(\w+)\]?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`
    if (!LARGE_OBJECTS.has(key)) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const persistedBracketedRe = /\[?(persistedview)\]?\.\[?(publish\.(?:revenue|balances))\]?/gi
  while ((m = persistedBracketedRe.exec(stripped)) !== null) {
    const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`
    if (!LARGE_OBJECTS.has(key)) continue
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
  | "write_disabled"
  | "non_temp_mutation"
  | "large_object_overused"
  | "unsafe_large_object_scan"

export interface QueryValidationDiagnostics {
  readonly ok: boolean
  readonly error: string | null
  readonly code: QueryValidationCode | null
  readonly analysis: MssqlQueryQualityAnalysis
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

function countTempScalarSubqueries(query: string): number {
  const stripped = stripForScan(query)
  return stripped.match(/\(\s*SELECT[\s\S]*?FROM\s+#\w+[\s\S]*?\)/gi)?.length ?? 0
}

export function countTempScalarSubqueriesByTemp(query: string): Map<string, number> {
  const stripped = stripForScan(query)
  const counts = new Map<string, number>()
  const matches = stripped.match(/\(\s*SELECT[\s\S]*?FROM\s+(#[A-Za-z_][\w]*)[\s\S]*?\)/gi) ?? []
  for (const match of matches) {
    const temp = /FROM\s+(#[A-Za-z_][\w]*)/i.exec(match)?.[1]
    if (!temp) continue
    counts.set(temp, (counts.get(temp) ?? 0) + 1)
  }
  return counts
}

export function analyzeMssqlQueryQuality(query: string): MssqlQueryQualityAnalysis {
  const largeObjectRefs = Array.from(countReferencedLargeObjects(query).entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const temp = analyzeTempTableBatch(query)
  const aggregateIssues = findAggregateSemanticIssues(query)
  const usesPersistedMirrors = largeObjectRefs
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("persistedview."))
  const missingPersistedMirrorCandidates: string[] = []
  if (largeObjectRefs.some((entry) => entry.name === "publish.revenue") && !usesPersistedMirrors.includes("persistedview.publish.revenue")) {
    missingPersistedMirrorCandidates.push("publish.revenue")
  }
  if (largeObjectRefs.some((entry) => entry.name === "publish.balances") && !usesPersistedMirrors.includes("persistedview.publish.balances")) {
    missingPersistedMirrorCandidates.push("publish.balances")
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

export function validateQuery(query: string, writeEnabled: boolean): string | null {
  return validateQueryDetailed(query, writeEnabled).error
}

export function validateQueryDetailed(query: string, writeEnabled: boolean): QueryValidationDiagnostics {
  const analysis = analyzeMssqlQueryQuality(query)
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
    }
  }

  const tempBatchError = validateTempTableBatch(query)
  if (tempBatchError) {
    return {
      ok: false,
      error: withFixHint(tempBatchError, "temp_table_integrity"),
      code: "temp_table_integrity",
      analysis,
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

  const largeRefCounts = countReferencedLargeObjects(query)
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
  const largeRefs = referencedLargeObjects(query)
  const scanReason = isUnsafeScan(query, largeRefs)
  if (scanReason) {
    const objects = largeRefs.join(", ")
    return {
      ok: false,
      error: [
        `Query blocked — would cause a full scan of large object(s): ${objects} (${scanReason}).`,
        ``,
        `Large publish views are UNION views over 10–60 fact tables with 100M–2B rows each. Use the persisted mirror when available.`,
        `An unfiltered query re-executes the entire view and will run for minutes / never complete.`,
        ``,
        `Required fix:`,
        `1. First resolve the date/key range from a small lookup table:`,
        `      SELECT MIN(pkMonth) AS fromPkMonth, MAX(pkMonth) AS toPkMonth FROM dim.Date WITH (NOLOCK) WHERE [Year] = 2025`,
        `2. Then query the large view WITH a WHERE predicate that narrows the scan:`,
        `      SELECT ... FROM persistedView.[publish.Revenue] WITH (NOLOCK) WHERE pkMonth BETWEEN <fromPkMonth> AND <toPkMonth> GROUP BY ...`,
        `3. Add WITH (NOLOCK) for read-only analytical queries.`,
        `4. Never use ORDER BY without WHERE on a large view — it forces a full sort of all rows.`,
        `5. If checking what data exists: query sys.partitions or dim.Date — NOT the view itself.`,
      ].join("\n"),
      code: "unsafe_large_object_scan",
      analysis,
    }
  }

  return { ok: true, error: null, code: null, analysis }
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
// wrong number (N× the true value).
//
// Camelcase-aware: matches either at a word boundary (`\bAverageCredit…`,
// `EOMBalance`) OR right after a lowercase letter (`MonthlyAvg`, `dailySpot`).
// We DO NOT require a trailing word boundary — `AverageCreditBalanceZARMTD`
// must trigger on `Average`, even though `Average` is followed by `C`
// (camelcase, no `\b` between them).
const PREAGGREGATED_COL_RE = /(?:\b|(?<=[a-z]))(Average|Avg|Mean|Median|Spot|EOM|Eod|Latest|Snapshot|EndOf|AsOf|StartOf|MTD|YTD|QTD|WTD)/i

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
      const colMatch = PREAGGREGATED_COL_RE.exec(argText)
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
export function getQueryWarnings(query: string): string | null {
  const warns = findAggregateSemanticIssues(query).filter((i) => i.severity === AggregateSeverity.Warn)
  if (warns.length === 0) return null
  const lines = [
    `⚠ SQL CORRECTNESS WARNING — review BEFORE trusting the numbers below:`,
    ``,
  ]
  for (const w of warns) {
    lines.push(`  • line ${w.line}: ${w.snippet}`)
    lines.push(`    ${w.message}`)
    lines.push(``)
  }
  lines.push(`If the warning is a false positive, re-run the query with an explicit alias that names the operation (e.g. \`SumOfMonthlyAverages\`) — the result will be returned without re-flagging.`)
  lines.push(`---`)
  return lines.join("\n")
}

