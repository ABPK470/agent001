/**
 * Sync diff engine — public barrel.
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
 * Implementation lives in:
 *   diff-engine/types.ts        — DiffOptions + internal interfaces + META_EXCLUDED_COLUMNS
 *   diff-engine/sql-helpers.ts  — qtable, runQueryWithRetry, hashExpr, quoting, batch WHERE
 *   diff-engine/columns.ts      — fetchTableColumns, fetchPkHash
 *   diff-engine/samples.ts      — fetchSamples, fetchUpdateSamples
 *   diff-engine/conflicts.ts    — detectScopeMisattribution
 *
 * NOTE: There is NO `checkSum` column on these tables (verified 2026-04-27 against
 * live UAT mymi DB). All earlier hash-column logic was based on a false assumption.
 */

import { SyncPlanChangeType } from "../../domain/enums/sync.js"
import type { AgentHost } from "../../host/index.js"
import { getPool } from "../../tools/index.js"
import type {
    SyncPlanGraph,
    SyncPlanTable,
    SyncPlanTableCounts,
} from "../plan-store.js"
import type { SyncRecipe, SyncRecipeTable } from "../recipes.js"
import { instantiatePredicate, instantiatePredicateWithTree } from "../recipes.js"
import { fetchPkHash, fetchTableColumns } from "./columns.js"
import { detectScopeMisattribution } from "./conflicts.js"
import { fetchSamples, fetchUpdateSamples } from "./samples.js"
import { DEFAULT_OPTS, type DiffOptions, type PkHashRow } from "./types.js"

export type { DiffOptions } from "./types.js"

export async function diffTable(
  host: AgentHost,
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
  const { pool: srcPool } = await getPool(host, sourceConn)
  const colInfo = await fetchTableColumns(host, srcPool, table.name)
  if (colInfo.hashColumns.length === 0) {
    return emptyResult(table, predicate, [`Table ${table.name} has no comparable non-meta columns — diff skipped.`], Date.now() - t0)
  }

  // 2–3. Pull pk + rowHash from BOTH environments in parallel.
  const { pool: tgtPool } = await getPool(host, targetConn)
  const [srcRows, tgtRows] = await Promise.all([
    fetchPkHash(host, srcPool, table.name, predicate, pkColumns, colInfo),
    fetchPkHash(host, tgtPool, table.name, predicate, pkColumns, colInfo),
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
    host,
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
    fetchSamples(host, srcPool, table.name, inserts.slice(0, o.sampleSize), pkColumns),
    fetchUpdateSamples(host, srcPool, tgtPool, table.name, updates.slice(0, o.sampleSize), pkColumns),
    fetchSamples(host, tgtPool, table.name, deletes.slice(0, o.sampleSize), pkColumns),
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

// ── Build a dependency graph from per-table results ──────────────

export function buildDependencyGraph(
  recipe: SyncRecipe,
  tableResults: SyncPlanTable[],
): SyncPlanGraph {
  const byName = new Map(tableResults.map((t) => [t.table, t]))
  const nodes: SyncPlanGraph["nodes"] = recipe.tables.map((t: SyncRecipeTable) => {
    const r = byName.get(t.name)
    const counts = r?.counts ?? { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0 }
    let status: SyncPlanGraph["nodes"][number]["status"] = SyncPlanChangeType.Unchanged
    if (counts.delete > 0) status = SyncPlanChangeType.Deletes
    else if (counts.insert > 0) status = SyncPlanChangeType.Inserts
    else if (counts.update > 0) status = SyncPlanChangeType.Updates
    return { id: t.name, label: t.name.split(".").pop() ?? t.name, status, counts }
  })
  // Edges: parent table → child tables (rough — root → all others as a fan).
  const edges: SyncPlanGraph["edges"] = []
  for (const t of recipe.tables) {
    if (t.name !== recipe.rootTable) edges.push({ from: recipe.rootTable, to: t.name })
  }
  return { nodes, edges }
}
