/**
 * MSSQL data profiling tool — quick statistical analysis of table data.
 *
 * Gives the agent deep understanding of what's actually IN the data:
 * row counts, null rates, distinct values, min/max, top frequent values,
 * and sample rows. Essential for a data-first platform.
 */

import sql from "mssql"
import { currentRuntime } from "../agent-runtime.js"
import type { AgentHost } from "../host/index.js"
import { getTenantConfig } from "../tenant/config.js"
import type { Tool } from "../types.js"
import { fingerprintForQname, persistToCache, tryServeFromCache } from "./_tool-cache.js"
import { getCatalog } from "./catalog/store.js"
import { getPool } from "./mssql/index.js"
import { isLargeObject } from "./mssql/validation.js"

function markProfileDataCalled(qname: string): void {
  try {
    currentRuntime().mssql.profileDataCalled.add(qname.toLowerCase())
  } catch {
    // Runtime may not be installed (tests) — silent.
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function escapeIdentifier(name: string): string {
  return `[${name.replace(/\]/g, "]]")}]`
}

function parseTableName(input: string): { schema: string; table: string } | null {
  // Handles: schema.table, [schema].[table], schema.[table.with.dots],
  // and the persistedView mirror spelling persistedView.[publish.Revenue].
  // Strategy: locate the first dot that is OUTSIDE of brackets — that's
  // the schema/table separator. Then strip any surrounding brackets from
  // each part.
  const trimmed = input.trim()
  let depth = 0
  let splitAt = -1
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === "[") depth++
    else if (ch === "]") depth--
    else if (ch === "." && depth === 0) { splitAt = i; break }
  }
  if (splitAt < 0) return null
  const strip = (s: string) => s.trim().replace(/^\[(.*)\]$/, "$1")
  const schema = strip(trimmed.slice(0, splitAt))
  const table = strip(trimmed.slice(splitAt + 1))
  if (!schema || !table) return null
  return { schema, table }
}

// ── Mirror-freshness comparison (Plan v3 Phase 2) ────────────────
//
// Generic MSSQL primitive: compare a canonical object to its persisted
// mirror (`<mirrorSchema>.<canonical-qname>`) without scanning either.
// Two cheap DMV queries:
//   1. sys.dm_db_partition_stats — row count per object (heap + clustered
//      index pages). Sub-millisecond at any data size.
//   2. STATS_DATE(object_id, stats_id) — last time statistics were
//      refreshed (cheap proxy for "freshness" — actual data freshness
//      depends on ETL but stats_date is the best generic signal).
//
// The recommendation is decided at the caller level (LLM-friendly enum)
// from `deltaPct` and `freshHours`:
//   - mirror missing                          → USE_CANONICAL
//   - |deltaPct| ≤ MAX_DELTA_PCT and          → USE_MIRROR
//     freshHours ≤ MAX_FRESH_HOURS
//   - otherwise                                → INSUFFICIENT_DATA
//   - mirror reports more rows than canonical → INSUFFICIENT_DATA
//
// No tenant data required beyond `mirrorSchema`. Works on any MSSQL DB
// that uses the `<mirrorSchema>.<canonical-qname>` convention.

const COMPARE_MIRROR_MAX_DELTA_PCT = 5
const COMPARE_MIRROR_MAX_FRESH_HOURS = 24

interface ObjectStats {
  qname: string
  rows: number | null         // null when the object doesn't exist
  statsDate: Date | null
  exists: boolean
}

async function fetchObjectStats(
  pool: sql.ConnectionPool,
  schema: string,
  name: string,
): Promise<ObjectStats> {
  const qname = `${schema}.${name}`
  const req = pool.request()
  req.input("schema", sql.NVarChar, schema)
  req.input("name", sql.NVarChar, name)
  // OBJECT_ID handles bracketed identifiers; we pass the bracketed form
  // to be safe against dotted names like persistedView.[publish.Revenue].
  req.input("fullName", sql.NVarChar, `${escapeIdentifier(schema)}.${escapeIdentifier(name)}`)
  const res = await req.query(`
    DECLARE @oid INT = OBJECT_ID(@fullName);
    SELECT
      @oid AS object_id,
      COALESCE((
        SELECT SUM(row_count)
        FROM sys.dm_db_partition_stats
        WHERE object_id = @oid AND index_id IN (0, 1)
      ), 0) AS row_count,
      (
        SELECT MAX(STATS_DATE(object_id, stats_id))
        FROM sys.stats
        WHERE object_id = @oid
      ) AS stats_date
  `)
  const row = res.recordset[0] as { object_id: number | null; row_count: number; stats_date: Date | null }
  if (row.object_id == null) {
    return { qname, rows: null, statsDate: null, exists: false }
  }
  return {
    qname,
    rows: row.row_count,
    statsDate: row.stats_date,
    exists: true,
  }
}

type MirrorRecommendation = "USE_MIRROR" | "USE_CANONICAL" | "INSUFFICIENT_DATA"

export interface CompareMirrorResult {
  canonical: { qname: string; rows: number | null; statsDate: string | null }
  mirror: { qname: string; rows: number | null; statsDate: string | null }
  deltaPct: number | null
  freshHours: number | null
  recommendation: MirrorRecommendation
  reason: string
}

/**
 * Pure decision function — exported for unit-testing without a live pool.
 * Input is the two ObjectStats; output is the LLM-facing recommendation.
 */
export function decideMirrorRecommendation(
  canonical: ObjectStats,
  mirror: ObjectStats,
  now: Date = new Date(),
  maxDeltaPct: number = COMPARE_MIRROR_MAX_DELTA_PCT,
  maxFreshHours: number = COMPARE_MIRROR_MAX_FRESH_HOURS,
): CompareMirrorResult {
  const base: CompareMirrorResult = {
    canonical: {
      qname: canonical.qname,
      rows: canonical.rows,
      statsDate: canonical.statsDate ? canonical.statsDate.toISOString() : null,
    },
    mirror: {
      qname: mirror.qname,
      rows: mirror.rows,
      statsDate: mirror.statsDate ? mirror.statsDate.toISOString() : null,
    },
    deltaPct: null,
    freshHours: null,
    recommendation: "INSUFFICIENT_DATA",
    reason: "",
  }

  if (!mirror.exists) {
    return { ...base, recommendation: "USE_CANONICAL", reason: "mirror object does not exist" }
  }
  if (!canonical.exists) {
    return { ...base, recommendation: "INSUFFICIENT_DATA", reason: "canonical object does not exist" }
  }
  const cRows = canonical.rows ?? 0
  const mRows = mirror.rows ?? 0
  if (cRows === 0) {
    return { ...base, recommendation: "INSUFFICIENT_DATA", reason: "canonical has zero rows; cannot compute delta" }
  }
  const deltaPct = ((mRows - cRows) / cRows) * 100
  base.deltaPct = Number(deltaPct.toFixed(2))

  const freshHours = mirror.statsDate
    ? (now.getTime() - mirror.statsDate.getTime()) / 3_600_000
    : null
  base.freshHours = freshHours != null ? Number(freshHours.toFixed(1)) : null

  // Mirror reports MORE rows than canonical → suspicious (duplicate
  // load, missing predicate, schema drift). Refuse to substitute.
  if (mRows > cRows * (1 + maxDeltaPct / 100)) {
    return { ...base, recommendation: "INSUFFICIENT_DATA", reason: `mirror has ${base.deltaPct}% more rows than canonical` }
  }
  if (Math.abs(deltaPct) > maxDeltaPct) {
    return { ...base, recommendation: "INSUFFICIENT_DATA", reason: `row delta ${base.deltaPct}% exceeds ±${maxDeltaPct}% threshold` }
  }
  if (freshHours == null) {
    return { ...base, recommendation: "INSUFFICIENT_DATA", reason: "mirror has no STATS_DATE — freshness unknown" }
  }
  if (freshHours > maxFreshHours) {
    return { ...base, recommendation: "INSUFFICIENT_DATA", reason: `mirror stats ${base.freshHours}h old, exceeds ${maxFreshHours}h threshold` }
  }
  return {
    ...base,
    recommendation: "USE_MIRROR",
    reason: `mirror within ±${maxDeltaPct}% of canonical (${base.deltaPct}%) and fresh (${base.freshHours}h ≤ ${maxFreshHours}h)`,
  }
}

function formatCompareMirror(result: CompareMirrorResult): string {
  const fmtRows = (n: number | null) => n == null ? "(n/a)" : n.toLocaleString()
  const fmtDate = (s: string | null) => s ?? "(none)"
  const lines = [
    `compare_mirror result:`,
    `  canonical: ${result.canonical.qname}`,
    `    rows=${fmtRows(result.canonical.rows)}  stats_date=${fmtDate(result.canonical.statsDate)}`,
    `  mirror:    ${result.mirror.qname}`,
    `    rows=${fmtRows(result.mirror.rows)}  stats_date=${fmtDate(result.mirror.statsDate)}`,
    `  deltaPct:  ${result.deltaPct == null ? "(n/a)" : `${result.deltaPct}%`}`,
    `  freshHours:${result.freshHours == null ? " (n/a)" : ` ${result.freshHours}h`}`,
    `  recommendation: ${result.recommendation}`,
    `  reason: ${result.reason}`,
  ]
  return lines.join("\n")
}

async function runCompareMirror(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
): Promise<string> {
  const tenant = getTenantConfig()
  const mirrorSchema = tenant.mirrorSchema
  if (!mirrorSchema) {
    return [
      `Error: compareMirror requires tenant.mirrorSchema to be configured.`,
      `This deployment has no mirror schema, so mirror substitution does not apply.`,
      `Use profile_data with mode='fast' (the default) for a normal profile.`,
    ].join("\n")
  }
  // The canonical input is the user-supplied schema.table. The mirror
  // form follows the deployment convention `<mirrorSchema>.<canonical-qname>`
  // — i.e. the mirror object's NAME is the full canonical qname.
  const canonical = await fetchObjectStats(pool, schema, table)
  const mirrorName = `${schema}.${table}`
  const mirror = await fetchObjectStats(pool, mirrorSchema, mirrorName)
  const result = decideMirrorRecommendation(canonical, mirror)
  return formatCompareMirror(result)
}

// ── Fast profile ─────────────────────────────────────────────────
//
// All four queries hit metadata / DMVs only — no row scans:
//   1. sys.objects                       → table vs view + object_id
//   2. INFORMATION_SCHEMA.COLUMNS        → columns, types, nullability
//   3. sys.dm_db_partition_stats         → row count (tables only)
//   4. sys.indexes / sys.index_columns   → index list + key cols
//   5. sys.stats + dm_db_stats_histogram → per-column min/max + last stats refresh
//   6. SELECT TOP N FROM table           → sample rows (clustered-index scan, bounded)
//
// On a 51M-row dim this returns in <100ms instead of ~30s. The agent
// gets enough to write the real query without paying for a scan.

interface FastColumnStat {
  column_name: string
  min_val: unknown
  max_val: unknown
  last_updated: Date | null
  modification_counter: number | null
}

async function runFastProfile(
  pool: sql.ConnectionPool,
  schema: string,
  table: string,
  sampleCount: number,
  requestedColumns: string[] | undefined,
): Promise<string> {
  const fullTable = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`
  const qn = `${schema}.${table}`

  // 1. Object identity (table vs view, object_id)
  const objRequest = pool.request()
  objRequest.input("schema", sql.NVarChar, schema)
  objRequest.input("table", sql.NVarChar, table)
  const objResult = await objRequest.query(`
    SELECT o.object_id, o.type, o.type_desc
    FROM sys.objects o
    INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE s.name = @schema AND o.name = @table AND o.type IN ('U', 'V')
  `)
  if (!objResult.recordset.length) {
    return `No table or view found at ${qn}. Check the name with explore_mssql_schema.`
  }
  const objectId = objResult.recordset[0].object_id as number
  const isView = objResult.recordset[0].type === "V"

  // 2. Columns
  const colRequest = pool.request()
  colRequest.input("schema", sql.NVarChar, schema)
  colRequest.input("table", sql.NVarChar, table)
  const colResult = await colRequest.query(`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table
    ORDER BY ORDINAL_POSITION
  `)
  let columns = colResult.recordset as Array<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>
  if (requestedColumns && requestedColumns.length > 0) {
    const want = new Set(requestedColumns.map((c) => c.toLowerCase()))
    const filtered = columns.filter((c) => want.has(c.COLUMN_NAME.toLowerCase()))
    if (filtered.length > 0) columns = filtered
  }

  // 3. Row count (tables only — no DMV equivalent for views)
  let rowCount: number | null = null
  if (!isView) {
    const countResult = await pool
      .request()
      .input("oid", sql.Int, objectId)
      .query(`
        SELECT SUM(row_count) AS rc
        FROM sys.dm_db_partition_stats
        WHERE object_id = @oid AND index_id IN (0, 1)
      `)
    rowCount = (countResult.recordset[0]?.rc as number | null) ?? 0
  }

  // 4. Indexes (tables only)
  const indexes: Array<{ name: string; type: string; cols: string[] }> = []
  if (!isView) {
    const ixResult = await pool
      .request()
      .input("oid", sql.Int, objectId)
      .query(`
        SELECT i.name AS index_name,
               i.type_desc,
               c.name AS col_name,
               ic.key_ordinal
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = @oid AND i.type > 0 AND ic.is_included_column = 0
        ORDER BY i.index_id, ic.key_ordinal
      `)
    const byName = new Map<string, { type: string; cols: string[] }>()
    for (const r of ixResult.recordset as Array<{ index_name: string; type_desc: string; col_name: string }>) {
      const e = byName.get(r.index_name) ?? { type: r.type_desc, cols: [] }
      e.cols.push(r.col_name)
      byName.set(r.index_name, e)
    }
    for (const [name, e] of byName) indexes.push({ name, type: e.type, cols: e.cols })
  }

  // 5. Per-column min/max from stats histogram (tables only, columns with stats)
  const statsByCol = new Map<string, FastColumnStat>()
  if (!isView) {
    try {
      const statsResult = await pool
        .request()
        .input("oid", sql.Int, objectId)
        .query(`
          SELECT c.name AS column_name,
                 MIN(CAST(h.range_high_key AS NVARCHAR(400))) AS min_val,
                 MAX(CAST(h.range_high_key AS NVARCHAR(400))) AS max_val,
                 MAX(dp.last_updated) AS last_updated,
                 MAX(dp.modification_counter) AS modification_counter
          FROM sys.stats s
          CROSS APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) dp
          CROSS APPLY sys.dm_db_stats_histogram(s.object_id, s.stats_id) h
          JOIN sys.stats_columns sc
            ON sc.object_id = s.object_id AND sc.stats_id = s.stats_id AND sc.stats_column_id = 1
          JOIN sys.columns c
            ON c.object_id = s.object_id AND c.column_id = sc.column_id
          WHERE s.object_id = @oid
          GROUP BY c.name
        `)
      for (const r of statsResult.recordset as FastColumnStat[]) {
        statsByCol.set(r.column_name.toLowerCase(), r)
      }
    } catch {
      // dm_db_stats_histogram requires VIEW DATABASE STATE; silently degrade.
    }
  }

  // 6. Sample rows (bounded TOP N — clustered-index scan, fast).
  // SKIP on known-large UNION views: even `SELECT TOP N FROM publish.Revenue`
  // can materialise all branches under some plans. Caller can sample a
  // specific branch via query_mssql if a sample is genuinely needed.
  const sampleCols = columns.slice(0, 8).map((c) => escapeIdentifier(c.COLUMN_NAME)).join(", ")
  let sampleRows: Array<Record<string, unknown>> = []
  const sampleSkippedLarge = isLargeObject(qn)
  if (!sampleSkippedLarge) {
    try {
      const sampleResult = await pool.request().query(
        `SELECT TOP ${sampleCount} ${sampleCols} FROM ${fullTable}`,
      )
      sampleRows = sampleResult.recordset as Array<Record<string, unknown>>
    } catch {
      // Sample failed (e.g. view with bad permissions) — continue without it.
    }
  }

  // ── Build output ─────────────────────────────────────────────
  const out: string[] = []
  out.push(`Profile (FAST mode) for ${qn}:`)
  out.push(`  Type: ${isView ? "VIEW" : "TABLE"}`)
  if (rowCount !== null) {
    out.push(`  Total rows: ${rowCount.toLocaleString()}  (from sys.dm_db_partition_stats — no scan)`)
  } else {
    out.push(`  Total rows: (not available for views in fast mode; use a filtered query_mssql to count)`)
  }
  out.push("")

  if (indexes.length > 0) {
    out.push(`Indexes (${indexes.length}):`)
    for (const ix of indexes) {
      out.push(`  ${ix.name} [${ix.type}]: ${ix.cols.join(", ")}`)
    }
    out.push("")
  }

  out.push(`Columns (${columns.length}):`)
  for (const c of columns) {
    const stat = statsByCol.get(c.COLUMN_NAME.toLowerCase())
    const nullable = c.IS_NULLABLE === "YES" ? "nullable" : "NOT NULL"
    out.push(`  ${c.COLUMN_NAME} (${c.DATA_TYPE}, ${nullable})`)
    if (stat) {
      const minStr = stat.min_val === null || stat.min_val === undefined ? "NULL" : String(stat.min_val)
      const maxStr = stat.max_val === null || stat.max_val === undefined ? "NULL" : String(stat.max_val)
      const updated = stat.last_updated instanceof Date ? stat.last_updated.toISOString().slice(0, 10) : "unknown"
      const mods = stat.modification_counter ?? 0
      out.push(`    Min: ${minStr} | Max: ${maxStr}  (stats updated ${updated}, ${mods.toLocaleString()} mods since)`)
    }
  }

  if (sampleSkippedLarge) {
    out.push("")
    out.push(`Sample rows: skipped (${qn} is a known-large UNION view / fact table — a TOP-N`)
    out.push(`  against it can materialise every branch). To sample, query a specific source`)
    out.push(`  branch with query_mssql (use inspect_definition to discover the branches).`)
  } else if (sampleRows.length > 0) {
    out.push("")
    out.push(`Sample rows (${sampleRows.length}):`)
    const cols = Object.keys(sampleRows[0])
    out.push(`  ${cols.join(" | ")}`)
    for (const row of sampleRows) {
      const vals = cols.map((c) => {
        const v = row[c]
        if (v === null || v === undefined) return "NULL"
        if (v instanceof Date) return v.toISOString()
        const s = String(v)
        return s.length > 30 ? s.slice(0, 27) + "..." : s
      })
      out.push(`  ${vals.join(" | ")}`)
    }
  }

  out.push("")
  out.push(
    "(Fast mode: metadata + stats histogram only — no row scans. " +
    "For exact NULL counts, exact distinct counts, and TOP-N frequent values, " +
    "call with mode='deep' on a small table or filtered #temp subset.)",
  )

  return out.join("\n")
}

// ── The tool ─────────────────────────────────────────────────────

function buildProfileDataTool(host: AgentHost): Tool { return {
  name: "profile_data",
  description:
    "Profile a database table — quick statistical understanding of what's in it. " +
    "Two modes:\n" +
    "  • mode='fast' (DEFAULT, always safe, sub-second): row count from sys.dm_db_partition_stats, " +
    "columns+types+nullability, indexes, per-column min/max from stats histogram, TOP-N sample rows. " +
    "No table scans. Use this FIRST — for 95% of cases this is what you actually want.\n" +
    "  • mode='deep' (scans the table): adds full COUNT(*), exact per-column NULL counts, " +
    "COUNT(DISTINCT) per column, and TOP-N GROUP BY frequent values. " +
    "Use only on small tables (under ~5M rows) or on a filtered #temp subset. SLOW on large tables.\n" +
    "Always pass schema-qualified name (e.g. '<schema>.<Table>'). UNION big views are refused outright.",
  parameters: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description:
          "Schema-qualified table name to profile (e.g. '<schema>.<Table>'). Required.",
      },
      mode: {
        type: "string",
        enum: ["fast", "deep"],
        description:
          "'fast' (default) = metadata-only, no scans. 'deep' = full per-column NULL/distinct/TOP-N scans.",
      },
      columns: {
        type: "array",
        items: { type: "string" },
        description:
          "Specific columns to profile (optional). If omitted, profiles all columns. " +
          "Recommended for deep mode on wide tables.",
      },
      sample: {
        type: "number",
        description: "Number of sample rows to return (default: 5, max: 20).",
      },
      topN: {
        type: "number",
        description: "Number of top frequent values to show per column (default: 5, max: 10). DEEP MODE ONLY.",
      },
      connection: {
        type: "string",
        description: "Named database connection to use. Omit for default.",
      },
      compareMirror: {
        type: "boolean",
        description:
          "When true, run a mirror-freshness comparison instead of a normal profile. " +
          "Compares the canonical object to its '<mirrorSchema>.<canonical-qname>' mirror " +
          "using two DMV queries (sys.dm_db_partition_stats + STATS_DATE). Returns rows, " +
          "stats_date, deltaPct, freshHours, and a recommendation enum " +
          "(USE_MIRROR | USE_CANONICAL | INSUFFICIENT_DATA). Requires tenant.mirrorSchema. " +
          "Use BEFORE substituting the mirror in a query. Sub-second on any data size.",
      },
    },
    required: ["table"],
  },

  async execute(args) {
    const parsed = parseTableName(String(args.table).trim())
    if (!parsed) {
      return "Error: table must be schema-qualified (e.g. '<schema>.<Table>'). Use explore_mssql_schema to find table names."
    }
    const { schema, table } = parsed
    const sampleCount = Math.min(Math.max(Number(args.sample) || 5, 1), 20)
    const topN = Math.min(Math.max(Number(args.topN) || 5, 1), 10)
    const connName = args.connection ? String(args.connection).trim() : undefined
    const mode: "fast" | "deep" =
      String(args.mode || "fast").toLowerCase() === "deep" ? "deep" : "fast"

    // ── Mirror-freshness comparison (Plan v3 Phase 2) ──────────────
    //
    // Short-circuit: when compareMirror=true, bypass the normal profile
    // path entirely. Two DMV queries, structured result, no caching
    // (freshness is the whole point — stale answers defeat the purpose).
    if (args.compareMirror === true) {
      let pool: sql.ConnectionPool
      try {
        const result = await getPool(host, connName)
        pool = result.pool
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
      try {
        return await runCompareMirror(pool, schema, table)
      } catch (err) {
        return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // ── Cache: serve fresh results without touching MSSQL ───────────
    //
    // The org-wide tool_knowledge cache is checked BEFORE the scan-guard
    // and pool acquire: a cached deep profile is just as valid (and far
    // faster) as a live one. A hit also satisfies the validator's "must
    // profile big views before querying" rule because the agent receives
    // the same shape of report it would have from a live call.
    const qn = `${schema}.${table}`
    const fp = fingerprintForQname(host, qn, connName)
    const cached = tryServeFromCache(host, "profile_data", qn, mode, connName, fp)
    if (cached !== null) {
      markProfileDataCalled(qn)
      return cached
    }

    // ── Scan-guard: refuse DEEP profiling of known-large UNION views ──
    //
    // Deep profile runs unfiltered COUNT_BIG(*) + per-column NULL/
    // DISTINCT/TOP-N aggregates against the target. On a UNION view such
    // as publish.Revenue (10–60 branches, hundreds of millions of rows)
    // this scans every branch and always times out at 60s.
    //
    // FAST mode is metadata-only (sys.dm_db_partition_stats +
    // dm_db_stats_histogram + sys.indexes + INFORMATION_SCHEMA + a bounded
    // TOP-N sample that is skipped on large objects) — it never scans,
    // so the guard does NOT apply to fast mode and large objects are
    // welcome there.
    if (mode === "deep" && isLargeObject(qn)) {
      // Pick the first lineage source (if any) as a concrete worked
      // example. Falls back to generic shape advice when this object
      // has no lineage entry in the catalog.
      const catalog = getCatalog(host, connName ?? "default")
      const firstBranch = catalog?.getUnionBranches(qn)?.[0]
      const branchAdvice = firstBranch
        ? `  1. Profile a single branch view instead — e.g. for ${qn} use one of\n     its source branches such as ${firstBranch}.\n     Discover the branches with: inspect_definition(name='${qn}').`
        : `  1. Profile a narrower object instead — discover this view's source branches\n     with inspect_definition(name='${qn}') and profile one branch at a time.`
      return [
        `Error: refusing DEEP profile of ${qn} — this is a known-large UNION view / fact table`,
        `(hundreds of millions to billions of rows across many branches). A deep profile`,
        `would scan every branch and time out at 60s.`,
        ``,
        `Alternatives:`,
        `  0. Re-call profile_data with mode='fast' (the default) — metadata-only,`,
        `     sub-second, safe on any object size. Returns row count, columns, indexes,`,
        `     per-column min/max from stats histogram. No scan.`,
        branchAdvice,
        `  2. Read the row count and lineage from the catalog: search_catalog(table='${qn}')`,
        `     returns the row-count, branch count, and column list without touching SQL.`,
        `  3. Run a filtered query_mssql with an explicit WHERE on a high-selectivity key —`,
        `     the validator accepts filtered scans on large objects.`,
        `  4. If you genuinely need deep profile_data on this object, profile a #temp staged`,
        `     subset first: SELECT ... INTO #sample FROM ${qn} WHERE <predicate>;`,
        `     then call profile_data on #sample with mode='deep'.`,
      ].join("\n")
    }

    let pool: sql.ConnectionPool
    try {
      const result = await getPool(host, connName)
      pool = result.pool
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }

    if (mode === "fast") {
      try {
        const out = await runFastProfile(pool, schema, table, sampleCount, args.columns as string[] | undefined)
        // Cache only successful live runs. runFastProfile may return error
        // strings (e.g. "No columns found ..."); avoid poisoning the cache.
        if (typeof out === "string" && !out.startsWith("SQL Error:") && !out.startsWith("Error:") && !out.startsWith("No columns")) {
          persistToCache(host, "profile_data", qn, "fast", connName, out, fp)
        }
        return out
      } catch (err) {
        return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
      } finally {
        markProfileDataCalled(qn)
      }
    }

    try {
      const fullTable = `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`

      // Step 1: Get columns and their types
      const colRequest = pool.request()
      colRequest.input("schema", sql.NVarChar, schema)
      colRequest.input("table", sql.NVarChar, table)
      const colResult = await colRequest.query(`
        SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE
        FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
        ORDER BY c.ORDINAL_POSITION
      `)

      if (!colResult.recordset.length) {
        return `No columns found for ${schema}.${table}. Check the table name with explore_mssql_schema.`
      }

      // Filter to requested columns if specified
      let targetColumns = colResult.recordset as Array<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>
      if (args.columns && Array.isArray(args.columns)) {
        const requested = new Set((args.columns as string[]).map((c) => c.toLowerCase()))
        targetColumns = targetColumns.filter((c) => requested.has(c.COLUMN_NAME.toLowerCase()))
        if (targetColumns.length === 0) {
          return `None of the specified columns found. Available: ${colResult.recordset.map((c: Record<string, string>) => c.COLUMN_NAME).join(", ")}`
        }
      }

      // Cap columns to avoid huge queries on wide tables
      const maxCols = 15
      const truncatedCols = targetColumns.length > maxCols
      if (truncatedCols) targetColumns = targetColumns.slice(0, maxCols)

      // Step 2: Row count
      const countResult = await pool.request().query(
        `SELECT COUNT_BIG(*) AS row_count FROM ${fullTable}`,
      )
      const rowCount = countResult.recordset[0].row_count as number

      // Step 3: Per-column statistics (single query for efficiency)
      const statParts: string[] = []
      for (const col of targetColumns) {
        const escaped = escapeIdentifier(col.COLUMN_NAME)
        statParts.push(
          `SUM(CASE WHEN ${escaped} IS NULL THEN 1 ELSE 0 END) AS [null_${col.COLUMN_NAME}]`,
          `COUNT(DISTINCT ${escaped}) AS [distinct_${col.COLUMN_NAME}]`,
        )
        // Min/max for numeric, date, and string types (skip binary/image/xml)
        const canMinMax = !["image", "text", "ntext", "xml", "geography", "geometry", "hierarchyid", "sql_variant"].includes(col.DATA_TYPE.toLowerCase())
        if (canMinMax) {
          statParts.push(
            `MIN(${escaped}) AS [min_${col.COLUMN_NAME}]`,
            `MAX(${escaped}) AS [max_${col.COLUMN_NAME}]`,
          )
        }
      }

      let statsRecord: Record<string, unknown> = {}
      if (statParts.length > 0 && rowCount > 0) {
        const statsResult = await pool.request().query(
          `SELECT ${statParts.join(", ")} FROM ${fullTable}`,
        )
        statsRecord = statsResult.recordset[0] as Record<string, unknown>
      }

      // Step 4: Build output
      const sections: string[] = [
        `Profile for ${schema}.${table}:`,
        `Total rows: ${rowCount.toLocaleString()}`,
        "",
      ]

      for (const col of targetColumns) {
        const nullCount = (statsRecord[`null_${col.COLUMN_NAME}`] as number) ?? 0
        const distinctCount = (statsRecord[`distinct_${col.COLUMN_NAME}`] as number) ?? 0
        const nullPct = rowCount > 0 ? ((nullCount / rowCount) * 100).toFixed(1) : "0.0"
        const minVal = statsRecord[`min_${col.COLUMN_NAME}`]
        const maxVal = statsRecord[`max_${col.COLUMN_NAME}`]

        const parts = [
          `  ${col.COLUMN_NAME} (${col.DATA_TYPE}, ${col.IS_NULLABLE === "YES" ? "nullable" : "NOT NULL"})`,
          `    Distinct: ${distinctCount.toLocaleString()} | Nulls: ${nullCount.toLocaleString()} (${nullPct}%)`,
        ]
        if (minVal !== undefined) {
          const minStr = minVal instanceof Date ? minVal.toISOString() : String(minVal)
          const maxStr = maxVal instanceof Date ? (maxVal as Date).toISOString() : String(maxVal)
          parts.push(`    Min: ${minStr} | Max: ${maxStr}`)
        }
        sections.push(parts.join("\n"))
      }

      if (truncatedCols) {
        sections.push(`\n(Showing first ${maxCols} columns — specify 'columns' to profile specific ones)`)
      }

      // Step 5: Top N frequent values for each column (limit to first 5 columns to avoid too many queries)
      const topNCols = targetColumns.slice(0, 5)
      if (rowCount > 0 && topNCols.length > 0) {
        sections.push("\nTop frequent values:")
        for (const col of topNCols) {
          const escaped = escapeIdentifier(col.COLUMN_NAME)
          try {
            const topResult = await pool.request().query(
              `SELECT TOP ${topN} ${escaped} AS val, COUNT(*) AS cnt ` +
              `FROM ${fullTable} WHERE ${escaped} IS NOT NULL ` +
              `GROUP BY ${escaped} ORDER BY COUNT(*) DESC`,
            )
            if (topResult.recordset.length > 0) {
              sections.push(`  ${col.COLUMN_NAME}:`)
              for (const r of topResult.recordset) {
                const v = r.val instanceof Date ? r.val.toISOString() : String(r.val)
                sections.push(`    ${v} (${(r.cnt as number).toLocaleString()})`)
              }
            }
          } catch {
            // Some column types can't be grouped — skip silently
          }
        }
      }

      // Step 6: Sample rows
      if (rowCount > 0) {
        const sampleCols = targetColumns.slice(0, 8).map((c) => escapeIdentifier(c.COLUMN_NAME)).join(", ")
        const sampleResult = await pool.request().query(
          `SELECT TOP ${sampleCount} ${sampleCols} FROM ${fullTable}`,
        )
        if (sampleResult.recordset.length > 0) {
          sections.push(`\nSample rows (${sampleResult.recordset.length}):`)
          const cols = Object.keys(sampleResult.recordset[0] as Record<string, unknown>)
          sections.push(`  ${cols.join(" | ")}`)
          sections.push(`  ${cols.map((c) => "-".repeat(Math.min(c.length, 15))).join("-+-")}`)
          for (const row of sampleResult.recordset) {
            const r = row as Record<string, unknown>
            const vals = cols.map((c) => {
              const v = r[c]
              if (v === null || v === undefined) return "NULL"
              if (v instanceof Date) return v.toISOString()
              const s = String(v)
              return s.length > 30 ? s.slice(0, 27) + "..." : s
            })
            sections.push(`  ${vals.join(" | ")}`)
          }
        }
      }

      const out = sections.join("\n")
      persistToCache(host, "profile_data", qn, "deep", connName, out, fp)
      return out
    } catch (err) {
      return `SQL Error: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      // Phase 3: record that this table has been profiled this run, so the
      // big-view-without-profile-data nudge in the validator can stand down.
      // Done in `finally` because partial profile results (e.g. row count
      // succeeded, then one column failed) still constitute "profiled".
      markProfileDataCalled(qn)
    }
  },
} }

export const profileDataTool: Tool = (() => {
  const stub = {} as AgentHost
  const t = buildProfileDataTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    async execute(_args) {
      throw new Error("profileDataTool must be built via createProfileDataTool(host)")
    },
  }
})()

export function createProfileDataTool(host: AgentHost): Tool {
  return buildProfileDataTool(host)
}
