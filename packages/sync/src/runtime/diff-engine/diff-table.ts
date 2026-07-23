/**
 * Per-table diff driver — HASHBYTES row comparison across source/target.
 */

import type { AuthoredSyncDefinitionTable } from "@mia/shared-types"
import { movementFromChangeSet } from "@mia/shared-types"

import { buildChangeSet } from "../../core/diff-engine/change-set.js"
import type { SyncPlanGraph, SyncPlanTable, SyncPlanTableStats } from "../../domain/plan.js"
import { SyncPlanChangeType } from "../../domain/enums.js"
import { instantiatePredicate, instantiatePredicateWithTree } from "../../core/scope/predicate.js"
import type { PkHashRow } from "../../domain/diff-engine/types.js"
import type { DiffOptions } from "../../domain/diff-engine/types.js"
import { DEFAULT_OPTS } from "../../domain/diff-engine/types.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { fetchPkHash, fetchTableColumns } from "./columns.js"
import { detectScopeMisattribution } from "./conflicts.js"
import { fetchSamples, fetchUpdateSamples } from "./samples.js"

export async function diffTable(
  host: SyncRuntimeHost,
  table: AuthoredSyncDefinitionTable,
  entityId: string | number,
  sourceConn: string,
  targetConn: string,
  pkColumns: string[],
  opts: DiffOptions = {}
): Promise<SyncPlanTable> {
  const o = {
    rowCap: DEFAULT_OPTS.rowCap ?? 5_000_000,
    sampleSize: DEFAULT_OPTS.sampleSize ?? 50,
    expandedIds: DEFAULT_OPTS.expandedIds ?? null,
    telemetryContext: DEFAULT_OPTS.telemetryContext,
    ...opts
  }
  const t0 = Date.now()
  const predicate = o.expandedIds
    ? instantiatePredicateWithTree(table.predicate, entityId, o.expandedIds)
    : instantiatePredicate(table.predicate, entityId)
  const warnings: string[] = []

  if (pkColumns.length === 0) {
    return emptyResult(table, predicate, ["No PK columns — diff skipped."], Date.now() - t0)
  }

  if (!table.scd2Policy) {
    return emptyResult(
      table,
      predicate,
      [`Table ${table.name} has no frozen scd2Policy — republish the sync definition.`],
      Date.now() - t0,
    )
  }

  const excludeFromDiff = new Set(table.scd2Policy.excludeFromDiff)

  // 1. Discover the column list to hash (from source — assumes target is compatible).
  const colInfo = await fetchTableColumns(host, sourceConn, table.name, excludeFromDiff, o.telemetryContext)
  if (colInfo.hashColumns.length === 0) {
    return emptyResult(
      table,
      predicate,
      [`Table ${table.name} has no comparable non-meta columns — diff skipped.`],
      Date.now() - t0
    )
  }

  // 2–3. Pull pk + rowHash from BOTH environments in parallel.
  const [srcRows, tgtRows] = await Promise.all([
    fetchPkHash(host, sourceConn, table.name, predicate, pkColumns, colInfo, o.telemetryContext),
    fetchPkHash(host, targetConn, table.name, predicate, pkColumns, colInfo, o.telemetryContext)
  ])
  if (srcRows.length > o.rowCap) {
    return emptyResult(
      table,
      predicate,
      [
        `Row cap exceeded: ${srcRows.length.toLocaleString()} > ${o.rowCap.toLocaleString()}. Refuse to plan; pass force=true to override.`
      ],
      Date.now() - t0
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
    if (!tgt) {
      inserts.push(src)
      continue
    }
    if (src.rowHash === tgt.rowHash) unchanged++
    else updates.push(src)
  }
  for (const [pk, tgt] of tgtByPk) {
    if (!srcByPk.has(pk)) deletes.push(tgt)
  }

  // 4b. Scope-misattribution detection.
  const conflicts = await detectScopeMisattribution(
    host,
    targetConn,
    table,
    entityId,
    pkColumns,
    inserts,
    o.sampleSize,
    o.telemetryContext
  )

  // Demote conflicting rows OUT of the insert bucket — they can't be inserted.
  if (conflicts.length > 0) {
    const conflictPks = new Set(conflicts.map((c) => c.pk))
    const remainingInserts = inserts.filter((r) => !conflictPks.has(r.pk))
    inserts.length = 0
    inserts.push(...remainingInserts)
    warnings.push(
      `${conflicts.length} row(s) blocked by scope misattribution. ` +
        `Execute will refuse to run until target metadata is fixed.`
    )
  }

  // 5. Sample rows — batched queries + parallelized across pools.
  const [insertSamples, updateSamples, deleteSamples] = await Promise.all([
    fetchSamples(host, sourceConn, table.name, inserts.slice(0, o.sampleSize), pkColumns, o.telemetryContext),
    fetchUpdateSamples(
      host,
      sourceConn,
      targetConn,
      table.name,
      updates.slice(0, o.sampleSize),
      pkColumns,
      excludeFromDiff,
      o.telemetryContext
    ),
    fetchSamples(host, targetConn, table.name, deletes.slice(0, o.sampleSize), pkColumns, o.telemetryContext)
  ])
  const samples = { insert: insertSamples, update: updateSamples, delete: deleteSamples }

  const stats: SyncPlanTableStats = {
    unchanged,
    lowConfidence: 0
  }

  return {
    table: table.name,
    scopePredicate: predicate,
    stats,
    changeSet: buildChangeSet(inserts, updates, deletes),
    samples,
    conflicts,
    warnings,
    diffDurationMs: Date.now() - t0
  }
}

function emptyResult(
  table: AuthoredSyncDefinitionTable,
  predicate: string,
  warnings: string[],
  ms: number
): SyncPlanTable {
  return {
    table: table.name,
    scopePredicate: predicate,
    stats: { unchanged: 0, lowConfidence: 0 },
    changeSet: buildChangeSet([], [], []),
    samples: { insert: [], update: [], delete: [] },
    conflicts: [],
    warnings,
    diffDurationMs: ms
  }
}

/** Build a dependency graph from per-table results. */
export function buildDependencyGraph(
  rootTable: string,
  tables: readonly Pick<AuthoredSyncDefinitionTable, "name">[],
  tableResults: SyncPlanTable[]
): SyncPlanGraph {
  const byName = new Map(tableResults.map((t) => [t.table, t]))
  const nodes: SyncPlanGraph["nodes"] = tables.map((t) => {
    const r = byName.get(t.name)
    const stats = r?.stats ?? { unchanged: 0, lowConfidence: 0 }
    const movement = r ? movementFromChangeSet(r.changeSet) : { insert: 0, update: 0, delete: 0 }
    let status: SyncPlanGraph["nodes"][number]["status"] = SyncPlanChangeType.Unchanged
    if (movement.delete > 0) status = SyncPlanChangeType.Deletes
    else if (movement.insert > 0) status = SyncPlanChangeType.Inserts
    else if (movement.update > 0) status = SyncPlanChangeType.Updates
    return { id: t.name, label: t.name.split(".").pop() ?? t.name, status, stats, movement }
  })
  // Edges: parent table → child tables (rough — root → all others as a fan).
  const edges: SyncPlanGraph["edges"] = []
  for (const t of tables) {
    if (t.name !== rootTable) edges.push({ from: rootTable, to: t.name })
  }
  return { nodes, edges }
}
