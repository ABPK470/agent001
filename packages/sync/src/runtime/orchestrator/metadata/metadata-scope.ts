/**
 * Which recipe tables participate in metadata-sync for a plan.
 *
 * Two independent concerns — never conflate:
 *   1. `constraintRelaxationTables` — FK NOCHECK/CHECK on ancestors through deepest change
 *   2. `dataMovementTables` — tables with insert/update PKs in changeSet
 *
 * @module
 */

import type { SyncPlan, SyncPlanTable } from "../plan-store.js"
import { hasChangeSetWork, hasUpsertWork } from "./plan-table.js"

function tableResult(plan: SyncPlan, name: string): SyncPlanTable | undefined {
  return plan.tables.find((t) => t.table === name)
}

/** FK constraint toggling — ancestors through the deepest table with any changeSet op. */
export function constraintRelaxationTables(plan: SyncPlan): Set<string> {
  const order = plan.executionContract.metadata.executionOrder
  const tables = new Set<string>()
  let maxChangeIndex = -1

  for (let i = 0; i < order.length; i++) {
    const name = order[i]!
    const row = tableResult(plan, name)
    if (row && hasChangeSetWork(row)) maxChangeIndex = Math.max(maxChangeIndex, i)
  }

  if (maxChangeIndex >= 0) {
    for (let i = 0; i <= maxChangeIndex; i++) {
      const name = order[i]!
      if (tableResult(plan, name)) tables.add(name)
    }
  }

  return tables
}

/** Data movement — tables with insert/update rows in changeSet. */
export function dataMovementTables(plan: SyncPlan): Set<string> {
  const tables = new Set<string>()
  for (const row of plan.tables) {
    if (hasUpsertWork(row)) tables.add(row.table)
  }
  return tables
}
