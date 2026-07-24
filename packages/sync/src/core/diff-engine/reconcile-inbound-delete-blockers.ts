/**
 * Pure reconcile: inbound FK hits → plan conflicts, without claiming ownership.
 *
 * Hits whose referencing row is already in this plan's changeSet.delete are
 * dropped (reverseOrder will remove them). Remaining hits become conflicts on
 * the deleted table and those delete PKs are demoted out of changeSet.
 */

import type { SyncPlanConflict, SyncPlanTable } from "../../domain/plan.js"

export interface InboundDeleteHit {
  deletedTable: string
  deletedPk: string
  referencingTable: string
  referencingColumn: string
  referencingPk: string
  constraintName: string
}

export function reconcileInboundDeleteBlockers(
  tables: readonly SyncPlanTable[],
  hits: readonly InboundDeleteHit[]
): SyncPlanTable[] {
  if (hits.length === 0) return [...tables]

  const deletePksByTable = new Map<string, Set<string>>()
  for (const table of tables) {
    deletePksByTable.set(
      table.table,
      new Set(table.changeSet.delete.map((row) => row.pk))
    )
  }

  const blockingHits = hits.filter((hit) => {
    const siblingDeletes = deletePksByTable.get(hit.referencingTable)
    return !siblingDeletes?.has(hit.referencingPk)
  })
  if (blockingHits.length === 0) return [...tables]

  const conflictsByTable = new Map<string, SyncPlanConflict[]>()
  const blockedDeletePks = new Map<string, Set<string>>()

  for (const hit of blockingHits) {
    const conflict: SyncPlanConflict = {
      kind: "inbound_reference",
      pk: hit.deletedPk,
      expectedScope: { table: hit.deletedTable, action: "delete" },
      actualScope: {
        referencingTable: hit.referencingTable,
        referencingColumn: hit.referencingColumn,
        referencingPk: hit.referencingPk,
        constraintName: hit.constraintName
      },
      summary:
        `Cannot delete pk=${hit.deletedPk} from ${hit.deletedTable}: still referenced by ` +
        `${hit.referencingTable}.${hit.referencingColumn} (referencing pk=${hit.referencingPk}, ` +
        `constraint ${hit.constraintName}). That referencing row is outside this plan's owned ` +
        `scope — fix or sync its owner first; this plan will not delete it.`
    }
    const list = conflictsByTable.get(hit.deletedTable) ?? []
    list.push(conflict)
    conflictsByTable.set(hit.deletedTable, list)

    const blocked = blockedDeletePks.get(hit.deletedTable) ?? new Set<string>()
    blocked.add(hit.deletedPk)
    blockedDeletePks.set(hit.deletedTable, blocked)
  }

  return tables.map((table) => {
    const newConflicts = conflictsByTable.get(table.table)
    const blocked = blockedDeletePks.get(table.table)
    if (!newConflicts?.length && !blocked?.size) return table

    const remainingDeletes = blocked
      ? table.changeSet.delete.filter((row) => !blocked.has(row.pk))
      : table.changeSet.delete

    const warnings = [...table.warnings]
    if (newConflicts?.length) {
      warnings.push(
        `${newConflicts.length} delete(s) blocked by inbound references outside this plan's scope. ` +
          `Execute will refuse until those references are fixed by their owners.`
      )
    }

    return {
      ...table,
      changeSet: {
        ...table.changeSet,
        delete: remainingDeletes
      },
      conflicts: [...table.conflicts, ...(newConflicts ?? [])],
      warnings
    }
  })
}
