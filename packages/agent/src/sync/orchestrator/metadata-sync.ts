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
import { EventType } from "../../domain/enums/event.js"
import { SyncProgressKind } from "../../domain/enums/sync.js"
import type { AgentHost } from "../../host/index.js"
import { type SyncPlan, type SyncPlanTable } from "../plan-store.js"
import { emitSyncEvent as emit, type SyncSqlTraceContext } from "../sync-events.js"
import { applyDeletes, applyInsertsUpdates } from "./apply.js"
import { maybeArchive } from "./archive.js"
import { qtable, trackedQuery } from "./db-helpers.js"
import type { ExecuteProgress } from "./types.js"

export interface RunMetadataSyncInput {
  host: AgentHost
  plan: SyncPlan
  planId: string
  pkByTable: Map<string, string[]>
  triggerCache: Map<string, boolean>
  onProgress: (p: ExecuteProgress) => void
  target: string
  tgtPool: import("mssql").ConnectionPool
  syncTrace?: SyncSqlTraceContext | null
}

export async function runMetadataSync(
  input: RunMetadataSyncInput,
): Promise<{ applied: { insert: number; update: number; delete: number } }> {
  const { plan, planId, pkByTable, triggerCache, onProgress, target, tgtPool } = input
  const host = input.host
  const syncTrace = input.syncTrace ?? null

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
      try { await trackedQuery(host, tx.request(), `ALTER TABLE ${qtable(t)} NOCHECK CONSTRAINT ALL`, `nocheck-constraint(${t})`, target, syncTrace) }
      catch (e) { console.warn(`[sync.execute] NOCHECK CONSTRAINT failed for ${t}:`, e) }
    }

    // Inserts + Updates: parents → children
    for (const tableName of plan.recipeSnapshot.executionOrder) {
      const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
      if (!tableResult) continue
      if (tableResult.counts.insert + tableResult.counts.update === 0) continue
      const rowsTotal = tableResult.counts.insert + tableResult.counts.update
      onProgress({ type: SyncProgressKind.TableStarted, table: tableName, rowsTotal })
      emit(host, EventType.SyncExecuteTableStart, { planId, table: tableName, op: "upsert", rowsTotal })
      await maybeArchive(host, plan, tableName, triggerCache, syncTrace)
      const applied = await applyInsertsUpdates(host, tx, plan, tableName, pkByTable.get(tableName) ?? [], syncTrace)
      appliedTotals.update += applied
      onProgress({ type: SyncProgressKind.TableDone, table: tableName, rowsApplied: applied })
      emit(host, EventType.SyncExecuteTableDone, { planId, table: tableName, op: "upsert", rowsApplied: applied })
    }

    // Deletes: children → parents
    for (const tableName of plan.recipeSnapshot.reverseOrder) {
      const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
      if (!tableResult || tableResult.counts.delete === 0) continue
      onProgress({ type: SyncProgressKind.TableStarted, table: tableName, rowsTotal: tableResult.counts.delete })
      emit(host, EventType.SyncExecuteTableStart, { planId, table: tableName, op: "delete", rowsTotal: tableResult.counts.delete })
      const applied = await applyDeletes(host, tx, plan, tableName, pkByTable.get(tableName) ?? [], syncTrace)
      appliedTotals.delete += applied
      onProgress({ type: SyncProgressKind.TableDone, table: tableName, rowsApplied: applied })
      emit(host, EventType.SyncExecuteTableDone, { planId, table: tableName, op: "delete", rowsApplied: applied })
    }

    // Re-enable FK constraints only on tables we disabled them on
    for (const t of allTables) {
      if (!affectedTables.has(t)) continue
      try { await trackedQuery(host, tx.request(), `ALTER TABLE ${qtable(t)} WITH CHECK CHECK CONSTRAINT ALL`, `check-constraint(${t})`, target, syncTrace) }
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
