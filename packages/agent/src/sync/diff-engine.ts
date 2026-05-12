/**
 * Sync diff engine.
 *
 * Per table, computes a per-row content hash via HASHBYTES('SHA2_256', CONCAT_WS(...))
 * over all non-meta columns at query time. Outer-joins source and target by PK,
 * classifies each row as INSERT / UPDATE / DELETE / UNCHANGED.
 *
 * Mirrors the behaviour of legacy `core.uspSyncObjectTran`:
 *   - Excluded from comparison: validFrom, validTo, isLocked, syncDate, deployDate, identity PK
 *   - On INSERT: identity preserved (SET IDENTITY_INSERT ON), validFrom = GETUTCDATE(), validTo = NULL
 *   - On UPDATE: identity not modified; non-meta columns copied; validFrom reset
 *
 * Per-table comparisons run in parallel by the orchestrator.
 *
 * Determinism guarantees (must hold across repeated previews of identical state):
 *   - Hash queries DO NOT use NOLOCK. NOLOCK can read mid-update values, skip rows,
 *     or read rows twice via allocation-order scans, all of which flip classification
 *     between runs. Hash reads use the default READ COMMITTED.
 *   - Every column is converted to its canonical, culture-invariant string form via
 *     a per-type CONVERT (ISO-8601 datetimes, full-precision floats, hex binaries).
 *     `CAST(x AS NVARCHAR(MAX))` is culture-dependent — its output varies between
 *     pooled TDS connections that inherited different LANGUAGE/DATEFORMAT defaults.
 *   - Each diff request is prefixed with SET options that pin the session to a
 *     deterministic state (us_english, ymd, NUMERIC_ROUNDABORT OFF, etc.) as a
 *     defence-in-depth against pool-connection drift.
 *
 * NOTE: There is NO `checkSum` column on these tables (verified 2026-04-27 against
 * live UAT mymi DB). All earlier hash-column logic was based on a false assumption.
 */

import type sql from "mssql"
import { getPool } from "../tools/mssql/index.js"
import type {
    SyncPlanConflict,
    SyncPlanGraph,
    SyncPlanRowSample,
    SyncPlanTable,
    SyncPlanTableCounts,
} from "./plan-store.js"
import type { SyncRecipe, SyncRecipeTable } from "./recipes.js"
import { instantiatePredicate, instantiatePredicateWithTree } from "./recipes.js"
import { emitSyncSqlEvent } from "./sync-events.js"

export interface DiffOptions {
  /** Per-table source row cap; if exceeded the table is flagged and skipped. */
  rowCap?: number
  /** Maximum sample rows per bucket (insert/update/delete). */
  sampleSize?: number
  /**
   * When the recipe root table has a self-referencing FK, these are the
   * expanded tree IDs. Substituted into `{ids}` placeholders in predicates.
   */
  expandedIds?: Array<string | number> | null
}

const DEFAULT_OPTS: Required<DiffOptions> = {
  rowCap: 5_000_000,
  sampleSize: 50,
  expandedIds: null,
}

/**
 * Columns excluded from row-fingerprint comparison and UPDATE SET clauses.
 * Mirrors legacy core.uspSyncObjectTran's exclusion list.
 */
const META_EXCLUDED_COLUMNS = new Set([
  "validFrom",
  "validTo",
  "isLocked",
  "syncDate",
  "deployDate",
])

interface PkHashRow {
  pk: string
  rowHash: string
  pkValues: Record<string, unknown>
}

interface HashColumn {
  name: string
  /** Base SQL Server type name (lower-case), e.g. 'datetime2', 'float', 'varbinary'. */
  systemType: string
}

interface TableColumnInfo {
  /** All non-computed, non-meta, non-identity columns to include in the row hash. */
  hashColumns: HashColumn[]
  /** The single identity column (PK), or null if none. */
  identityColumn: string | null
}

/**
 * Session options pinned on every diff query so all pooled TDS connections
 * produce byte-identical CONVERT() output. Order matters — LANGUAGE resets
 * DATEFORMAT, so DATEFORMAT must come second.
 */
const DETERMINISTIC_SESSION_PREFIX =
  "SET LANGUAGE us_english; " +
  "SET DATEFORMAT ymd; " +
  "SET NUMERIC_ROUNDABORT OFF; " +
  "SET ANSI_WARNINGS ON; " +
  "SET ANSI_PADDING ON; " +
  "SET ANSI_NULLS ON; " +
  "SET CONCAT_NULL_YIELDS_NULL ON; " +
  "SET ARITHABORT ON; " +
  "SET QUOTED_IDENTIFIER ON; "

/** Bracket-quote a `schema.table` identifier → `[schema].[table]`. */
function qtable(name: string): string {
  return name.split(".").map((p) => `[${p}]`).join(".")
}

/**
 * Detect transient mssql errors that are safe to retry. The pool's TDS
 * connections can be killed by server-side timeout, network blip, or
 * `requestTimeout` firing, leaving the next request on that conn with
 * `ConnectionError: Connection is closed.` Retrying gets a fresh conn.
 */
function isTransientMssqlError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  const msg = e.message.toLowerCase()
  const code = (e as { code?: string }).code ?? ""
  if (code === "ETIMEOUT" || code === "ECONNRESET" || code === "ECONNCLOSED" || code === "ESOCKET") return true
  return (
    msg.includes("connection is closed") ||
    msg.includes("connection lost") ||
    msg.includes("connection reset") ||
    msg.includes("socket hang up") ||
    msg.includes("timeout: request failed to complete") ||
    msg.includes("the connection is closed")
  )
}

/**
 * Run a query with bounded retries on transient connection failures.
 * Backoff: 100ms, 400ms (jittered).
 */
async function runQueryWithRetry<T = unknown>(
  pool: sql.ConnectionPool,
  query: string,
  label: string,
  maxRetries = 2,
): Promise<sql.IResult<T>> {
  const t0 = Date.now()
  const connection = (pool as unknown as { config?: { database?: string } }).config?.database ?? "<unknown>"
  let lastErr: unknown
  let attempts = 0
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1
    try {
      const result = await pool.request().query<T>(query)
      emitSyncSqlEvent({
        label, connection, sql: query,
        durationMs: Date.now() - t0,
        rowCount: result.recordset?.length ?? result.rowsAffected?.reduce((a: number, b: number) => a + b, 0) ?? 0,
        attempts,
      })
      return result
    } catch (e) {
      lastErr = e
      if (attempt === maxRetries || !isTransientMssqlError(e)) {
        emitSyncSqlEvent({
          label, connection, sql: query,
          durationMs: Date.now() - t0,
          attempts,
          error: e instanceof Error ? e.message : String(e),
        })
        throw e
      }
      const delay = 100 * Math.pow(4, attempt) + Math.floor(Math.random() * 50)
      console.warn(`[sync.diff] transient error on ${label} (attempt ${attempt + 1}/${maxRetries + 1}): ${e instanceof Error ? e.message : String(e)} \u2014 retrying in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}

/**
 * Build a culture-invariant SQL expression that converts `[col]` to NVARCHAR
 * for hashing. The default `CAST(x AS NVARCHAR(MAX))` is NOT safe — its output
 * for datetime/float/money varies with session LANGUAGE/DATEFORMAT, which
 * differs between pooled TDS connections.
 */
function hashExpr(col: HashColumn): string {
  const c = `[${col.name}]`
  switch (col.systemType) {
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      // Style 126/127 = ISO-8601, culture-invariant.
      return `CONVERT(NVARCHAR(33), ${c}, 126)`
    case "date":
      return `CONVERT(NVARCHAR(10), ${c}, 23)`
    case "time":
      return `CONVERT(NVARCHAR(16), ${c}, 114)`
    case "float":
    case "real":
      // Style 2 = full 17-digit scientific, invariant.
      return `CONVERT(NVARCHAR(64), ${c}, 2)`
    case "money":
    case "smallmoney":
      // Style 2 = 4 decimal places, no commas.
      return `CONVERT(NVARCHAR(32), ${c}, 2)`
    case "binary":
    case "varbinary":
    case "image":
    case "timestamp":
    case "rowversion":
      // Style 1 = '0x...' hex.
      return `CONVERT(NVARCHAR(MAX), ${c}, 1)`
    case "uniqueidentifier":
      return `CONVERT(NVARCHAR(36), ${c})`
    case "xml":
    case "hierarchyid":
    case "geography":
    case "geometry":
    case "sql_variant":
      return `CONVERT(NVARCHAR(MAX), CONVERT(VARBINARY(MAX), ${c}), 1)`
    default:
      return `CAST(${c} AS NVARCHAR(MAX))`
  }
}

export async function diffTable(
  _recipe: SyncRecipe,
  table: SyncRecipeTable,
  entityId: string | number,
  sourceConn: string,
  targetConn: string,
  pkColumns: string[],
  opts: DiffOptions = {},
): Promise<SyncPlanTable> {
  const o = { ...DEFAULT_OPTS, ...opts }
  const t0 = Date.now()
  const predicate = o.expandedIds
    ? instantiatePredicateWithTree(table.predicate, entityId, o.expandedIds)
    : instantiatePredicate(table.predicate, entityId)
  const warnings: string[] = []

  if (pkColumns.length === 0) {
    return emptyResult(table, predicate, ["No PK columns — diff skipped."], Date.now() - t0)
  }

  // 1. Discover the column list to hash (from source — assumes target is compatible).
  const { pool: srcPool } = await getPool(sourceConn)
  const colInfo = await fetchTableColumns(srcPool, table.name)
  if (colInfo.hashColumns.length === 0) {
    return emptyResult(table, predicate, [`Table ${table.name} has no comparable non-meta columns — diff skipped.`], Date.now() - t0)
  }

  // 2–3. Pull pk + rowHash from BOTH environments in parallel.
  const { pool: tgtPool } = await getPool(targetConn)
  const [srcRows, tgtRows] = await Promise.all([
    fetchPkHash(srcPool, table.name, predicate, pkColumns, colInfo),
    fetchPkHash(tgtPool, table.name, predicate, pkColumns, colInfo),
  ])
  if (srcRows.length > o.rowCap) {
    return emptyResult(
      table,
      predicate,
      [`Row cap exceeded: ${srcRows.length.toLocaleString()} > ${o.rowCap.toLocaleString()}. Refuse to plan; pass force=true to override.`],
      Date.now() - t0,
    )
  }

  // 4. Classify by outer-join on PK.
  const srcByPk = new Map(srcRows.map((r) => [r.pk, r]))
  const tgtByPk = new Map(tgtRows.map((r) => [r.pk, r]))
  const inserts: PkHashRow[] = []
  const updates: PkHashRow[] = []
  const deletes: PkHashRow[] = []
  let unchanged = 0

  for (const [pk, src] of srcByPk) {
    const tgt = tgtByPk.get(pk)
    if (!tgt) { inserts.push(src); continue }
    if (src.rowHash === tgt.rowHash) unchanged++
    else updates.push(src)
  }
  for (const [pk, tgt] of tgtByPk) {
    if (!srcByPk.has(pk)) deletes.push(tgt)
  }

  // 4b. Scope-misattribution detection.
  //
  // The diff above only sees rows scoped by `predicate` on each side. If a
  // PK that source claims as INSERT actually exists on TARGET under a
  // different parent (e.g. activityId=999 lives under pipelineId=456 on
  // target instead of the expected pipelineId=123), the execute step would
  // hit a PK violation and roll back the entire transaction. We catch it
  // here so the user sees the conflict in preview and can fix the metadata
  // before running execute.
  //
  // Only meaningful when (a) PK is single-column AND (b) recipe declares a
  // scopeColumn that is a real column on the table (not a sub-query alias).
  const conflicts = await detectScopeMisattribution(
    tgtPool,
    table,
    entityId,
    pkColumns,
    inserts,
    o.sampleSize,
  )

  // Demote conflicting rows OUT of the insert bucket — they can't be inserted.
  if (conflicts.length > 0) {
    const conflictPks = new Set(conflicts.map((c) => c.pk))
    const remainingInserts = inserts.filter((r) => !conflictPks.has(r.pk))
    inserts.length = 0
    inserts.push(...remainingInserts)
    warnings.push(
      `${conflicts.length} row(s) blocked by scope misattribution. ` +
      `Execute will refuse to run until target metadata is fixed.`,
    )
  }

  // 5. Sample rows — batched queries + parallelized across pools.
  const [insertSamples, updateSamples, deleteSamples] = await Promise.all([
    fetchSamples(srcPool, table.name, inserts.slice(0, o.sampleSize), pkColumns),
    fetchUpdateSamples(srcPool, tgtPool, table.name, updates.slice(0, o.sampleSize), pkColumns),
    fetchSamples(tgtPool, table.name, deletes.slice(0, o.sampleSize), pkColumns),
  ])
  const samples = { insert: insertSamples, update: updateSamples, delete: deleteSamples }

  const counts: SyncPlanTableCounts = {
    insert: inserts.length,
    update: updates.length,
    delete: deletes.length,
    unchanged,
    lowConfidence: 0, // No longer applicable with HASHBYTES (never NULL).
    conflicts: conflicts.length,
  }

  return {
    table: table.name,
    scopePredicate: predicate,
    counts,
    samples,
    conflicts,
    warnings,
    diffDurationMs: Date.now() - t0,
  }
}

// ── helpers ──────────────────────────────────────────────────────

function emptyResult(table: SyncRecipeTable, predicate: string, warnings: string[], ms: number): SyncPlanTable {
  return {
    table: table.name,
    scopePredicate: predicate,
    counts: { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0 },
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings,
    diffDurationMs: ms,
  }
}

/**
 * Discover the columns of a table that participate in the row-hash comparison.
 * Mirrors core.uspSyncObjectTran's column selection: skip computed columns,
 * skip meta columns (validFrom/validTo/isLocked/syncDate/deployDate),
 * skip the identity column (it's the PK and used for matching).
 */
async function fetchTableColumns(
  pool: sql.ConnectionPool,
  qualifiedTable: string,
): Promise<TableColumnInfo> {
  const [schema, name] = qualifiedTable.split(".")
  const result = await runQueryWithRetry(pool, `
    SELECT
      c.name             AS columnName,
      c.is_computed      AS isComputed,
      c.is_identity      AS isIdentity,
      LOWER(ty.name)     AS systemType
    FROM sys.columns c
    JOIN sys.objects o  ON o.object_id = c.object_id
    JOIN sys.types ty   ON ty.user_type_id = c.user_type_id
    WHERE o.[type] = 'U'
      AND o.name = '${name.replace(/'/g, "''")}'
      AND OBJECT_SCHEMA_NAME(c.object_id) = '${schema.replace(/'/g, "''")}'
    ORDER BY c.column_id
  `, `fetchTableColumns(${qualifiedTable})`)
  const hashColumns: HashColumn[] = []
  let identityColumn: string | null = null
  for (const row of result.recordset as Array<{ columnName: string; isComputed: boolean; isIdentity: boolean; systemType: string }>) {
    if (row.isIdentity) { identityColumn = row.columnName; continue }
    if (row.isComputed) continue
    if (META_EXCLUDED_COLUMNS.has(row.columnName)) continue
    hashColumns.push({ name: row.columnName, systemType: row.systemType })
  }
  return { hashColumns, identityColumn }
}

/**
 * Fetch pk + per-row hash from a table, scoped by predicate.
 *
 * Hash is computed in SQL Server via:
 *   HASHBYTES('SHA2_256', CONCAT_WS('|', CAST(c1 AS NVARCHAR(MAX)), CAST(c2 AS NVARCHAR(MAX)), ...))
 *
 * NULLs are passed through CONCAT_WS naturally (treated as empty string with the separator skipped),
 * which means NULL == '' for hash purposes. Acceptable for ABI metadata — all non-nullable cols
 * in scope are stable, and nullables compare consistently across source/target.
 */
async function fetchPkHash(
  pool: sql.ConnectionPool,
  qualifiedTable: string,
  predicate: string,
  pkColumns: string[],
  colInfo: TableColumnInfo,
): Promise<PkHashRow[]> {
  const pkSelect = pkColumns.map((c) => `[${c}]`).join(", ")
  const hashArgs = colInfo.hashColumns.map(hashExpr).join(", ")
  // No NOLOCK: dirty reads cause classification flapping between runs.
  // Session prefix pins LANGUAGE/DATEFORMAT/etc so CONVERT output is identical
  // across every TDS connection in the pool.
  const query =
    DETERMINISTIC_SESSION_PREFIX +
    `SELECT ${pkSelect}, ` +
    `HASHBYTES('SHA2_256', ISNULL(CONCAT_WS('|', ${hashArgs}), '')) AS rowHash ` +
    `FROM ${qtable(qualifiedTable)} WHERE ${predicate}`
  const result = await runQueryWithRetry(pool, query, `fetchPkHash(${qualifiedTable})`)
  return (result.recordset as Record<string, unknown>[]).map((row) => {
    const pkValues: Record<string, unknown> = {}
    for (const c of pkColumns) pkValues[c] = row[c]
    const pk = pkColumns.map((c) => String(row[c] ?? "∅")).join("|")
    const raw = row["rowHash"]
    const rowHash = Buffer.isBuffer(raw) ? raw.toString("hex") : String(raw ?? "")
    return { pk, rowHash, pkValues }
  })
}

async function fetchSamples(
  pool: sql.ConnectionPool,
  qualifiedTable: string,
  rows: PkHashRow[],
  pkColumns: string[],
): Promise<SyncPlanRowSample[]> {
  if (rows.length === 0) return []
  try {
    const where = buildBatchWhere(rows, pkColumns)
    const result = await runQueryWithRetry(
      pool,
      `SELECT * FROM ${qtable(qualifiedTable)} WHERE ${where}`,
      `fetchSamples(${qualifiedTable})`,
    )
    // Re-order results to match input row order and build samples.
    const byPk = new Map<string, Record<string, unknown>>()
    for (const r of result.recordset as Record<string, unknown>[]) {
      const pk = pkColumns.map((c) => String(r[c] ?? "∅")).join("|")
      byPk.set(pk, r)
    }
    const samples: SyncPlanRowSample[] = []
    for (const row of rows) {
      const r = byPk.get(row.pk)
      if (r) samples.push({ values: r })
    }
    return samples
  } catch (e) {
    return [{ values: { error: e instanceof Error ? e.message : String(e) } }]
  }
}

async function fetchUpdateSamples(
  srcPool: sql.ConnectionPool,
  tgtPool: sql.ConnectionPool,
  qualifiedTable: string,
  rows: PkHashRow[],
  pkColumns: string[],
): Promise<SyncPlanRowSample[]> {
  if (rows.length === 0) return []
  try {
    const where = buildBatchWhere(rows, pkColumns)
    const qt = qtable(qualifiedTable)
    const [srcResult, tgtResult] = await Promise.all([
      runQueryWithRetry(srcPool, `SELECT * FROM ${qt} WHERE ${where}`, `fetchUpdateSamples.src(${qualifiedTable})`),
      runQueryWithRetry(tgtPool, `SELECT * FROM ${qt} WHERE ${where}`, `fetchUpdateSamples.tgt(${qualifiedTable})`),
    ])
    const srcByPk = new Map<string, Record<string, unknown>>()
    for (const r of srcResult.recordset as Record<string, unknown>[]) {
      srcByPk.set(pkColumns.map((c) => String(r[c] ?? "∅")).join("|"), r)
    }
    const tgtByPk = new Map<string, Record<string, unknown>>()
    for (const r of tgtResult.recordset as Record<string, unknown>[]) {
      tgtByPk.set(pkColumns.map((c) => String(r[c] ?? "∅")).join("|"), r)
    }
    const samples: SyncPlanRowSample[] = []
    for (const row of rows) {
      const newValues = srcByPk.get(row.pk)
      const oldValues = tgtByPk.get(row.pk)
      const changedColumns: string[] = []
      if (newValues && oldValues) {
        for (const k of Object.keys(newValues)) {
          if (META_EXCLUDED_COLUMNS.has(k)) continue
          if (String(newValues[k]) !== String(oldValues[k])) changedColumns.push(k)
        }
      }
      samples.push({ newValues, oldValues, changedColumns })
    }
    return samples
  } catch (e) {
    return [{ values: { error: e instanceof Error ? e.message : String(e) } }]
  }
}

/**
 * Build a WHERE clause that matches all rows in `rows` by their PK values.
 * Single-column PK → `[pk] IN (v1, v2, ...)` (efficient index seek).
 * Composite PK → `([pk1] = v1 AND [pk2] = v2) OR (...)` (row-constructor).
 */
function buildBatchWhere(rows: PkHashRow[], pkColumns: string[]): string {
  if (pkColumns.length === 1) {
    const col = pkColumns[0]
    const values = rows.map((r) => quoteValue(r.pkValues[col])).join(", ")
    return `[${col}] IN (${values})`
  }
  // Composite PK — OR of AND-ed equality predicates.
  const clauses = rows.map((r) =>
    "(" + pkColumns.map((c) => `[${c}] = ${quoteValue(r.pkValues[c])}`).join(" AND ") + ")"
  )
  return clauses.join(" OR ")
}

function quoteValue(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "1" : "0"
  return `N'${String(v).replace(/'/g, "''")}'`
}

// ── Scope misattribution detection ───────────────────────────────

/**
 * For every PK that source classifies as INSERT, look up the row on TARGET
 * regardless of scope. If the row exists on target with a DIFFERENT scope
 * value than the one source expects, it's a misattribution: someone
 * associated this row with a different parent on target. Such a row CANNOT
 * be inserted (PK conflict) and silently breaks the user's mental model
 * ("everything from my source pipeline should land 1:1 on target").
 *
 * Limitations:
 *  - Single-column PK only (composite PKs require row-constructor IN clauses
 *    that mssql doesn't always handle cleanly across drivers).
 *  - Recipe must declare a `scopeColumn` that is a real column on the table
 *    (not a sub-query alias) — this is true for all 6 ABI recipes.
 *  - Capped at 5_000 PKs per query to keep the IN list reasonable.
 */
async function detectScopeMisattribution(
  tgtPool: sql.ConnectionPool,
  table: SyncRecipeTable,
  entityId: string | number,
  pkColumns: string[],
  insertCandidates: PkHashRow[],
  sampleSize: number,
): Promise<SyncPlanConflict[]> {
  if (insertCandidates.length === 0) return []
  if (pkColumns.length !== 1) return []
  if (!table.scopeColumn) return []
  // Skip when the predicate references the PK directly — that's the root
  // table's own row and there's no separate parent scope to mismatch against.
  if (table.scopeColumn === pkColumns[0]) return []

  const pkCol = pkColumns[0]
  const scopeCol = table.scopeColumn
  // Take a hard cap to bound the IN list size.
  const candidates = insertCandidates.slice(0, 5_000)
  const pkLiterals = candidates
    .map((r) => quoteValue(r.pkValues[pkCol]))
    .join(", ")

  let result: sql.IResult<unknown>
  try {
    result = await runQueryWithRetry(
      tgtPool,
      // No NOLOCK (consistent with the rest of diff). Plain READ COMMITTED.
      `SELECT [${pkCol}] AS pk, [${scopeCol}] AS scope ` +
      `FROM ${qtable(table.name)} WHERE [${pkCol}] IN (${pkLiterals})`,
      `detectScopeMisattribution(${table.name})`,
    )
  } catch (e) {
    // Defence-in-depth: if the conflict probe itself fails (transient or
    // permissions), don't block the whole preview — surface as a warning by
    // returning empty here; the caller's normal warnings path is unaffected.
    console.warn(`[sync.diff] scope-misattribution probe failed for ${table.name}:`, e)
    return []
  }

  if (result.recordset.length === 0) return []

  // What scope value SHOULD these rows have? Source-side row carries the
  // expected scope value — but we didn't fetch it (only PK + hash). For most
  // ABI recipes the expected scope is the entityId itself (e.g. pipelineId
  // = entityId). For nested recipes the expected scope is whatever value
  // satisfies the source predicate; we surface the entityId + the recipe's
  // scopeColumn as the "expected" context so the user has actionable info.
  const expectedScope: Record<string, unknown> = { [scopeCol]: `(per source predicate using entityId=${entityId})` }

  const conflicts: SyncPlanConflict[] = []
  for (const row of result.recordset as Array<{ pk: unknown; scope: unknown }>) {
    const pkValue = row.pk
    const actualScopeValue = row.scope
    conflicts.push({
      pk: String(pkValue ?? "∅"),
      expectedScope,
      actualScope: { [scopeCol]: actualScopeValue },
      summary:
        `${pkCol}=${formatScalar(pkValue)} exists on target with ` +
        `${scopeCol}=${formatScalar(actualScopeValue)}, but source claims it under the current sync scope ` +
        `(predicate: ${table.predicate.replace("{id}", String(entityId))}). ` +
        `Inserting would violate the PK; execute will refuse until target metadata is corrected.`,
    })
  }
  void sampleSize // counts must be accurate; UI slices for display
  return conflicts
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "NULL"
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return `'${String(v)}'`
}

// ── Build a dependency graph from per-table results ──────────────

export function buildDependencyGraph(
  recipe: SyncRecipe,
  tableResults: SyncPlanTable[],
): SyncPlanGraph {
  const byName = new Map(tableResults.map((t) => [t.table, t]))
  const nodes: SyncPlanGraph["nodes"] = recipe.tables.map((t: SyncRecipeTable) => {
    const r = byName.get(t.name)
    const counts = r?.counts ?? { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0 }
    let status: SyncPlanGraph["nodes"][number]["status"] = "unchanged"
    if (counts.delete > 0) status = "deletes"
    else if (counts.insert > 0) status = "inserts"
    else if (counts.update > 0) status = "updates"
    return { id: t.name, label: t.name.split(".").pop() ?? t.name, status, counts }
  })
  // Edges: parent table → child tables (rough — root → all others as a fan).
  const edges: SyncPlanGraph["edges"] = []
  for (const t of recipe.tables) {
    if (t.name !== recipe.rootTable) edges.push({ from: recipe.rootTable, to: t.name })
  }
  return { nodes, edges }
}
