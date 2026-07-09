/**
 * Sync plan view helpers — single source for movement counts.
 *
 * Insert / update / delete counts are always `changeSet` array lengths.
 * `stats` holds preview-only fields; conflict count is `conflicts.length`.
 */

export interface SyncPlanMovement {
  insert: number
  update: number
  delete: number
}

export interface SyncPlanTableStats {
  unchanged: number
  /** Reserved; HASHBYTES diff does not produce low-confidence rows. */
  lowConfidence: number
}

export interface SyncPlanChangeSetRef {
  insert: readonly unknown[]
  update: readonly unknown[]
  delete: readonly unknown[]
}

export interface SyncPlanTableMovementInput {
  changeSet: SyncPlanChangeSetRef
  conflicts: readonly unknown[]
}

export interface SyncPlanTotalsInput extends SyncPlanTableMovementInput {
  stats: SyncPlanTableStats
}

/** Movement counts from the execute authority (`changeSet` PK lists). */
export function movementFromChangeSet(changeSet: SyncPlanChangeSetRef): SyncPlanMovement {
  return {
    insert: changeSet.insert.length,
    update: changeSet.update.length,
    delete: changeSet.delete.length
  }
}

export function movementOfTable(table: Pick<SyncPlanTableMovementInput, "changeSet">): SyncPlanMovement {
  return movementFromChangeSet(table.changeSet)
}

/** Sort key / "has work" — movement plus scope conflicts. */
export function tableMovementTotal(table: SyncPlanTableMovementInput): number {
  const m = movementOfTable(table)
  return m.insert + m.update + m.delete + table.conflicts.length
}

export function tableHasMovement(table: Pick<SyncPlanTableMovementInput, "changeSet">): boolean {
  const m = movementOfTable(table)
  return m.insert + m.update + m.delete > 0
}

export function computePlanTotals(tables: readonly SyncPlanTotalsInput[]): {
  insert: number
  update: number
  delete: number
  unchanged: number
  lowConfidence: number
  conflicts: number
  tablesCount: number
} {
  return tables.reduce(
    (acc, t) => {
      const m = movementOfTable(t)
      return {
        insert: acc.insert + m.insert,
        update: acc.update + m.update,
        delete: acc.delete + m.delete,
        unchanged: acc.unchanged + t.stats.unchanged,
        lowConfidence: acc.lowConfidence + t.stats.lowConfidence,
        conflicts: acc.conflicts + t.conflicts.length,
        tablesCount: acc.tablesCount + (tableMovementTotal(t) > 0 ? 1 : 0)
      }
    },
    { insert: 0, update: 0, delete: 0, unchanged: 0, lowConfidence: 0, conflicts: 0, tablesCount: 0 }
  )
}
