/**
 * `runMetadataSync` — the in-transaction core of `executeSync`.
 *
 * Toggles FK constraints on affected tables only, runs MERGE for
 * inserts/updates parents → children, then DELETE for children → parents,
 * re-enables FKs, and commits the transaction. Returns applied row totals.
 *
 * Lives inside the transaction supplied by the caller; the caller is
 * responsible for opening it (so failure-path cleanup can rollback).
 *
 * @module
 */

import sqlMod from "mssql"
import { type SyncPlan, type SyncPlanTable } from "../plan-store.js"
import { emitSyncEvent as emit } from "../sync-events.js"
import { applyDeletes, applyInsertsUpdates } from "./apply.js"
import { maybeArchive } from "./archive.js"
import { qtable, trackedQuery } from "./db-helpers.js"
import type { ExecuteProgress } from "./types.js"

export interface RunMetadataSyncInput {
  plan: SyncPlan
  planId: string
  pkByTable: Map<string, string[]>
  triggerCache: Map<string, boolean>
  onProgress: (p: ExecuteProgress) => void
  target: string
  tgtPool: import("mssql").ConnectionPool
}

export async function runMetadataSync(
  input: RunMetadataSyncInput,
): Promise<{ applied: { insert: number; update: number; delete: number } }> {
  const { plan, planId, pkByTable, triggerCache, onProgress, target, tgtPool } = input

  const appliedTotals = { insert: 0, update: 0, delete: 0 }
  const allTables = plan.recipeSnapshot.executionOrder
  const tx = new sqlMod.Transaction(tgtPool)

  // Build the set of tables that actually have changes — only these need
  // FK constraint toggling. Avoids expensive WITH CHECK CHECK CONSTRAINT
  // re-validation scans on untouched tables (which can dominate execution
  // time for small syncs).
  const affectedTables = new Set<string>()
  for (const t of plan.tables) {
    if (t.counts.insert + t.counts.update + t.counts.delete > 0) {
      affectedTables.add(t.table)
    }
  }

  try {
    await tx.begin()

    // Disable FK constraints only on tables with changes
    for (const t of allTables) {
      if (!affectedTables.has(t)) continue
      try { await trackedQuery(tx.request(), `ALTER TABLE ${qtable(t)} NOCHECK CONSTRAINT ALL`, `nocheck-constraint(${t})`, target) }
      catch (e) { console.warn(`[sync.execute] NOCHECK CONSTRAINT failed for ${t}:`, e) }
    }

    // Inserts + Updates: parents → children
    for (const tableName of plan.recipeSnapshot.executionOrder) {
      const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
      if (!tableResult) continue
      if (tableResult.counts.insert + tableResult.counts.update === 0) continue
      const rowsTotal = tableResult.counts.insert + tableResult.counts.update
      onProgress({ type: "table-started", table: tableName, rowsTotal })
      emit("sync.execute.table.start", { planId, table: tableName, op: "upsert", rowsTotal })
      await maybeArchive(plan, tableName, triggerCache)
      const applied = await applyInsertsUpdates(tx, plan, tableName, pkByTable.get(tableName) ?? [])
      appliedTotals.update += applied
      onProgress({ type: "table-done", table: tableName, rowsApplied: applied })
      emit("sync.execute.table.done", { planId, table: tableName, op: "upsert", rowsApplied: applied })
    }

    // Deletes: children → parents
    for (const tableName of plan.recipeSnapshot.reverseOrder) {
      const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
      if (!tableResult || tableResult.counts.delete === 0) continue
      onProgress({ type: "table-started", table: tableName, rowsTotal: tableResult.counts.delete })
      emit("sync.execute.table.start", { planId, table: tableName, op: "delete", rowsTotal: tableResult.counts.delete })
      const applied = await applyDeletes(tx, plan, tableName, pkByTable.get(tableName) ?? [])
      appliedTotals.delete += applied
      onProgress({ type: "table-done", table: tableName, rowsApplied: applied })
      emit("sync.execute.table.done", { planId, table: tableName, op: "delete", rowsApplied: applied })
    }

    // Re-enable FK constraints only on tables we disabled them on
    for (const t of allTables) {
      if (!affectedTables.has(t)) continue
      try { await trackedQuery(tx.request(), `ALTER TABLE ${qtable(t)} WITH CHECK CHECK CONSTRAINT ALL`, `check-constraint(${t})`, target) }
      catch (e) { console.warn(`[sync.execute] CHECK CONSTRAINT failed for ${t}:`, e) }
    }

    await tx.commit()
    return { applied: appliedTotals }
  } catch (e) {
    // Re-enable FK constraints even on failure — best-effort
    for (const t of allTables) {
      try { await tx.request().query(`ALTER TABLE ${qtable(t)} WITH CHECK CHECK CONSTRAINT ALL`) }
      catch { /* tx may already be aborted */ }
    }
    try { await tx.rollback() } catch { /* ignore */ }
    throw e
  }
}
