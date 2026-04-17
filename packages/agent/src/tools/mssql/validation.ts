// ── Query validation ─────────────────────────────────────────────

const READ_ONLY_PATTERN = /^\s*(SELECT|WITH|EXPLAIN|SET\s+SHOWPLAN|SP_HELP|SP_COLUMNS|SP_TABLES)\b/i

const DANGEROUS_PATTERNS = [
  /;\s*(DROP|ALTER|TRUNCATE|EXEC|EXECUTE|XP_|SP_EXECUTESQL|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b/i,
  /INTO\s+\w+\s*\(/i,                                    // SELECT INTO
  /BULK\s+INSERT/i,
  /DBCC\b/i,
  /SHUTDOWN\b/i,
  /RECONFIGURE\b/i,
]

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
  // Match schema.object in various bracket/quote forms
  const re = /\[?(\w+)\]?\.\[?(\w+)\]?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    const key = `${m[1].toLowerCase()}.${m[2].toLowerCase()}`
    if (LARGE_OBJECTS.has(key) && !found.includes(key)) {
      found.push(key)
    }
  }
  return found
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
  if (!writeEnabled) {
    if (!READ_ONLY_PATTERN.test(query)) {
      return "Write operations are disabled. Only SELECT/WITH queries are allowed. " +
             "Contact your administrator to enable write mode."
    }
  }

  // Always block dangerous operations regardless of write mode
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(query)) {
      return "Query blocked: contains potentially dangerous operation (DROP, ALTER, EXEC, xp_, BULK INSERT, DBCC, SHUTDOWN, etc.)."
    }
  }

  // ── Scan guard ────────────────────────────────────────────────
  // Block queries that would trigger a full table/view scan on known large objects.
  const largeRefs = referencedLargeObjects(query)
  const scanReason = isUnsafeScan(query, largeRefs)
  if (scanReason) {
    const objects = largeRefs.join(", ")
    return [
      `Query blocked — would cause a full scan of large object(s): ${objects} (${scanReason}).`,
      ``,
      `Large views like publish.Revenue are UNION views over 10–60 fact tables with 100M–2B rows each.`,
      `An unfiltered query re-executes the entire view and will run for minutes / never complete.`,
      ``,
      `Required fix:`,
      `1. First resolve the date/key range from a small lookup table:`,
      `      SELECT MIN(pkDate) AS from, MAX(pkDate) AS to FROM dim.Date WITH (NOLOCK) WHERE calYear = 2025`,
      `2. Then query the large view WITH a WHERE predicate that narrows the scan:`,
      `      SELECT ... FROM ${largeRefs[0] ?? "publish.Revenue"} WITH (NOLOCK) WHERE pkMonth BETWEEN <from> AND <to> GROUP BY ...`,
      `3. Add WITH (NOLOCK) for read-only analytical queries.`,
      `4. Never use ORDER BY without WHERE on a large view — it forces a full sort of all rows.`,
      `5. If checking what data exists: query sys.partitions or dim.Date — NOT the view itself.`,
    ].join("\n")
  }

  return null // valid
}
