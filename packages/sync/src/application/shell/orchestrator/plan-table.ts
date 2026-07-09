/**
 * Per-table plan helpers — `changeSet` is the execute authority.
 *
 * SyncPlan = persisted preview envelope (entity, envs, contract, tables, …).
 * SyncPlanTable.changeSet = row-level insert/update/delete PK lists for one table.
 * Movement counts = `changeSet` array lengths (see `movementFromChangeSet`).
 *
 * @module
 */

import {
  computePlanTotals,
  movementFromChangeSet,
  movementOfTable,
  tableHasMovement,
  tableMovementTotal
} from "@mia/shared-types"
import type { PkHashRow } from "../../../domain/diff-engine/types.js"
import type { SyncPlan, SyncPlanChangeRow, SyncPlanChangeSet, SyncPlanTable } from "../plan-store.js"

export {
  computePlanTotals,
  movementFromChangeSet,
  movementOfTable,
  tableHasMovement,
  tableMovementTotal
}

function changeSetOf(table: SyncPlanTable): SyncPlanChangeSet {
  if (!table.changeSet) {
    throw new Error(`Plan table ${table.table} is missing changeSet — re-preview.`)
  }
  return table.changeSet
}

/** Insert + update PK rows to MERGE (execute reads full rows for these PKs only). */
export function upsertRows(table: SyncPlanTable): SyncPlanChangeRow[] {
  const cs = changeSetOf(table)
  return [...cs.insert, ...cs.update]
}

/** Delete PK rows (execute removes these on target only). */
export function deleteRows(table: SyncPlanTable): SyncPlanChangeRow[] {
  return changeSetOf(table).delete
}

export function hasUpsertWork(table: SyncPlanTable): boolean {
  return upsertRows(table).length > 0
}

export function hasChangeSetWork(table: SyncPlanTable): boolean {
  return tableHasMovement(table)
}

/** Require changeSet on every table; when `plan.totals` is present, verify it matches derived totals. */
export function validatePlan(plan: SyncPlan): void {
  for (const table of plan.tables) {
    if (!table.changeSet) {
      throw new Error(`Plan table ${table.table} is missing changeSet — re-preview.`)
    }
  }
  if (!plan.totals) return
  const derived = computePlanTotals(plan.tables)
  for (const key of ["insert", "update", "delete", "unchanged", "lowConfidence", "conflicts", "tablesCount"] as const) {
    if (plan.totals[key] !== derived[key]) {
      throw new Error(`Plan totals.${key} (${plan.totals[key]}) ≠ derived (${derived[key]}) — re-preview.`)
    }
  }
}

/** Adapt plan PK rows for diff-engine `buildBatchWhere`. */
export function changeRowsAsPkHash(rows: readonly SyncPlanChangeRow[]): PkHashRow[] {
  return rows.map((row) => ({ pk: row.pk, rowHash: "", pkValues: row.values }))
}
