/**
 * `runMetadataSync` — the in-transaction core of `executeSync`.
 *
 * Toggles FK constraints on `constraintRelaxationTables`, applies changeSet
 * upserts/deletes via `apply.ts`, re-enables FKs, and commits.
 *
 * @module
 */

import sqlMod from "mssql"
import { EventType, SyncProgressKind, type SyncRuntimeHost } from "../../../ports/index.js"
import { emitSyncEvent as emit, type SyncTelemetryContext } from "../events.js"
import { type SyncPlan, type SyncPlanTable } from "../plan-store.js"
import { applyDeletes, applyInsertsUpdates } from "./apply.js"
import { movementFromChangeSet } from "./plan-table.js"
import { maybeArchive } from "./archive.js"
import { qtable, trackedQuery } from "./db-helpers.js"
import { constraintRelaxationTables, dataMovementTables } from "./metadata-scope.js"
import { SyncExecuteError, toSyncExecuteError, type ExecuteProgress } from "./types.js"
import { deleteRows, upsertRows } from "./plan-table.js"

export interface RunMetadataSyncInput {
  host: SyncRuntimeHost
  plan: SyncPlan
  planId: string
  pkByTable: Map<string, string[]>
  triggerCache: Map<string, boolean>
  onProgress: (p: ExecuteProgress) => void
  target: string
  tgtPool: import("mssql").ConnectionPool
  telemetryContext?: SyncTelemetryContext
}

/** Re-enable constraints without validating existing rows (legacy uspSyncObjectTran parity). */
const ENABLE_CONSTRAINTS_SQL = (table: string) => `ALTER TABLE ${qtable(table)} CHECK CONSTRAINT ALL`

export async function runMetadataSync(
  input: RunMetadataSyncInput
): Promise<{ applied: { insert: number; update: number; delete: number } }> {
  const { plan, planId, pkByTable, triggerCache, onProgress, target, tgtPool, telemetryContext } = input
  const host = input.host

  const appliedTotals = { insert: 0, update: 0, delete: 0 }
  const pendingCommitted: Array<{ table: string; rowsApplied: number; op: "upsert" | "delete" }> = []
  const allTables = plan.executionContract.metadata.executionOrder
  const constraintTables = constraintRelaxationTables(plan)
  const movementTables = dataMovementTables(plan)
  const tx = new sqlMod.Transaction(tgtPool)

  const fail = (error: unknown, context: { table?: string; op?: string }) => {
    const failure = toSyncExecuteError(error, {
      step: "metadataSync",
      table: context.table,
      op: context.op
    })
    onProgress({
      type: SyncProgressKind.Step,
      step: failure.step,
      table: failure.table,
      message: failure.message,
      error: failure.causeDetail
    })
    emit(host, EventType.SyncExecuteStepFailed, {
      planId,
      step: failure.step,
      table: failure.table ?? null,
      op: failure.op ?? null,
      error: failure.message,
      cause: failure.causeDetail ?? null
    })
    return failure
  }

  try {
    await tx.begin()

    for (const t of allTables) {
      if (!constraintTables.has(t)) continue
      try {
        await trackedQuery(
          host,
          target,
          `ALTER TABLE ${qtable(t)} NOCHECK CONSTRAINT ALL`,
          `nocheck-constraint(${t})`,
          telemetryContext,
          tx.request()
        )
      } catch (error) {
        throw fail(error, { table: t, op: "nocheck-constraint" })
      }
    }

    for (const tableName of plan.executionContract.metadata.executionOrder) {
      const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
      if (!tableResult || !movementTables.has(tableName)) continue
      const rowsTotal = upsertRows(tableResult).length
      onProgress({ type: SyncProgressKind.TableStarted, table: tableName, rowsTotal })
      emit(host, EventType.SyncExecuteTableStart, { planId, table: tableName, op: "upsert", rowsTotal })
      try {
        await maybeArchive(host, plan, tableName, triggerCache)
        const applied = await applyInsertsUpdates(
          host,
          tx,
          plan,
          tableName,
          pkByTable.get(tableName) ?? [],
          telemetryContext
        )
        const movement = movementFromChangeSet(tableResult.changeSet)
        appliedTotals.insert += movement.insert
        appliedTotals.update += movement.update
        if (applied !== movement.insert + movement.update) {
          console.warn(
            `[sync.metadata] ${tableName}: MERGE rowsAffected (${applied}) ≠ changeSet movement (${movement.insert + movement.update})`
          )
        }
        onProgress({
          type: SyncProgressKind.TableProgress,
          table: tableName,
          rowsApplied: applied,
          rowsTotal,
          message: "Applied in transaction (not yet committed)",
        })
        pendingCommitted.push({ table: tableName, rowsApplied: applied, op: "upsert" })
      } catch (error) {
        throw fail(error, { table: tableName, op: "upsert" })
      }
    }

    for (const tableName of plan.executionContract.metadata.reverseOrder) {
      const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
      if (!tableResult) continue
      const toDelete = deleteRows(tableResult)
      if (toDelete.length === 0) continue
      onProgress({
        type: SyncProgressKind.TableStarted,
        table: tableName,
        rowsTotal: toDelete.length
      })
      emit(host, EventType.SyncExecuteTableStart, {
        planId,
        table: tableName,
        op: "delete",
        rowsTotal: toDelete.length
      })
      try {
        const applied = await applyDeletes(
          host,
          tx,
          plan,
          tableName,
          pkByTable.get(tableName) ?? [],
          telemetryContext
        )
        appliedTotals.delete += applied
        onProgress({
          type: SyncProgressKind.TableProgress,
          table: tableName,
          rowsApplied: applied,
          rowsTotal: toDelete.length,
          message: "Deleted in transaction (not yet committed)",
        })
        pendingCommitted.push({ table: tableName, rowsApplied: applied, op: "delete" })
      } catch (error) {
        throw fail(error, { table: tableName, op: "delete" })
      }
    }

    for (const t of allTables) {
      if (!constraintTables.has(t)) continue
      try {
        await trackedQuery(
          host,
          target,
          ENABLE_CONSTRAINTS_SQL(t),
          `check-constraint(${t})`,
          telemetryContext,
          tx.request()
        )
      } catch (error) {
        throw fail(error, { table: t, op: "check-constraint" })
      }
    }

    try {
      await tx.commit()
    } catch (error) {
      throw fail(error, { op: "commit" })
    }

    for (const entry of pendingCommitted) {
      onProgress({ type: SyncProgressKind.TableDone, table: entry.table, rowsApplied: entry.rowsApplied })
      emit(host, EventType.SyncExecuteTableDone, {
        planId,
        table: entry.table,
        op: entry.op,
        rowsApplied: entry.rowsApplied,
      })
    }

    return { applied: appliedTotals }
  } catch (e) {
    for (const t of allTables) {
      if (!constraintTables.has(t)) continue
      try {
        const rollbackCtx = telemetryContext
          ? { ...telemetryContext, scope: "rollback" }
          : undefined
        await trackedQuery(
          host,
          target,
          ENABLE_CONSTRAINTS_SQL(t),
          `rollback.check-constraint(${t})`,
          rollbackCtx,
          tx.request()
        )
      } catch {
        /* tx may already be aborted */
      }
    }
    try {
      await tx.rollback()
    } catch {
      /* ignore */
    }
    onProgress({
      type: SyncProgressKind.Step,
      step: "metadataSync",
      message: "Metadata sync rolled back — no target metadata changes were committed.",
    })
    for (const entry of pendingCommitted) {
      onProgress({
        type: SyncProgressKind.TableProgress,
        table: entry.table,
        rowsApplied: entry.rowsApplied,
        message: "Rolled back — not committed",
        error: "Transaction rolled back",
      })
    }
    throw e instanceof SyncExecuteError ? e : fail(e, { op: "transaction" })
  }
}
