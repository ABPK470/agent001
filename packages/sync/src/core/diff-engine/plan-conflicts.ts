/**
 * Pure reconcile for post-diff plan conflicts.
 *
 * Dialect: probe outside ownership → conflicts; never claim rows into changeSet.
 * Hits already covered by this plan's sibling changeSet work are dropped.
 */

import type { SyncPlanConflict, SyncPlanTable } from "../../domain/plan.js"

export type PlanConflictHit =
  | {
      kind: "inbound_reference"
      table: string
      pk: string
      referencingTable: string
      referencingColumn: string
      referencingPk: string
      constraintName: string
      /** Other FK column values on the referencing row (owner pointers). */
      owners?: Record<string, unknown>
    }
  | {
      kind: "missing_parent"
      table: string
      pk: string
      parentTable: string
      childColumn: string
      parentPk: string
      constraintName: string
    }

export function reconcilePlanConflicts(
  tables: readonly SyncPlanTable[],
  hits: readonly PlanConflictHit[]
): SyncPlanTable[] {
  if (hits.length === 0) return [...tables]

  const deletePksByTable = changeSetPkIndex(tables, "delete")
  const insertPksByTable = changeSetPkIndex(tables, "insert")
  const insertValuesByTable = changeSetValueIndex(tables, "insert")

  const blocking = hits.filter((hit) => {
    if (hit.kind === "inbound_reference") {
      return !deletePksByTable.get(hit.referencingTable)?.has(hit.referencingPk)
    }
    // Parent present in this plan's inserts (by PK string or referenced value).
    if (insertPksByTable.get(hit.parentTable)?.has(hit.parentPk)) return false
    const parentValues = insertValuesByTable.get(hit.parentTable)
    if (parentValues?.has(hit.parentPk)) return false
    return true
  })
  if (blocking.length === 0) return [...tables]

  const conflictsByTable = new Map<string, SyncPlanConflict[]>()
  const blockedDeletes = new Map<string, Set<string>>()
  const blockedInserts = new Map<string, Set<string>>()

  for (const hit of blocking) {
    const conflict = toConflict(hit)
    const list = conflictsByTable.get(hit.table) ?? []
    list.push(conflict)
    conflictsByTable.set(hit.table, list)

    if (hit.kind === "inbound_reference") {
      const set = blockedDeletes.get(hit.table) ?? new Set<string>()
      set.add(hit.pk)
      blockedDeletes.set(hit.table, set)
    } else {
      const set = blockedInserts.get(hit.table) ?? new Set<string>()
      set.add(hit.pk)
      blockedInserts.set(hit.table, set)
    }
  }

  return tables.map((table) => {
    const newConflicts = conflictsByTable.get(table.table)
    const delBlocked = blockedDeletes.get(table.table)
    const insBlocked = blockedInserts.get(table.table)
    if (!newConflicts?.length && !delBlocked?.size && !insBlocked?.size) return table

    const warnings = [...table.warnings]
    const inboundCount = newConflicts?.filter((c) => c.kind === "inbound_reference").length ?? 0
    const missingCount = newConflicts?.filter((c) => c.kind === "missing_parent").length ?? 0
    if (inboundCount > 0) {
      warnings.push(
        `${inboundCount} delete(s) blocked by inbound references outside this plan's scope. ` +
          `Execute will refuse until those references are fixed by their owners.`
      )
    }
    if (missingCount > 0) {
      warnings.push(
        `${missingCount} insert(s) blocked by missing parent rows on target (and not planned here). ` +
          `Execute will refuse until parents exist or are included in a plan that inserts them.`
      )
    }

    return {
      ...table,
      changeSet: {
        insert: insBlocked
          ? table.changeSet.insert.filter((row) => !insBlocked.has(row.pk))
          : table.changeSet.insert,
        update: table.changeSet.update,
        delete: delBlocked
          ? table.changeSet.delete.filter((row) => !delBlocked.has(row.pk))
          : table.changeSet.delete
      },
      conflicts: [...table.conflicts, ...(newConflicts ?? [])],
      warnings
    }
  })
}

function toConflict(hit: PlanConflictHit): SyncPlanConflict {
  if (hit.kind === "inbound_reference") {
    const ownerSuffix =
      hit.owners && Object.keys(hit.owners).length > 0
        ? ` Owner keys: ${Object.entries(hit.owners)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ")}.`
        : ""
    return {
      kind: "inbound_reference",
      pk: hit.pk,
      expectedScope: { table: hit.table, action: "delete" },
      actualScope: {
        referencingTable: hit.referencingTable,
        referencingColumn: hit.referencingColumn,
        referencingPk: hit.referencingPk,
        constraintName: hit.constraintName,
        ...(hit.owners && Object.keys(hit.owners).length > 0 ? { owners: hit.owners } : {})
      },
      summary:
        `Cannot delete pk=${hit.pk} from ${hit.table}: still referenced by ` +
        `${hit.referencingTable}.${hit.referencingColumn} (referencing pk=${hit.referencingPk}, ` +
        `constraint ${hit.constraintName}). That referencing row is outside this plan's owned ` +
        `scope — fix or sync its owner first; this plan will not delete it.` +
        ownerSuffix
    }
  }

  return {
    kind: "missing_parent",
    pk: hit.pk,
    expectedScope: {
      table: hit.table,
      action: "insert",
      [hit.childColumn]: hit.parentPk
    },
    actualScope: {
      parentTable: hit.parentTable,
      parentPk: hit.parentPk,
      constraintName: hit.constraintName
    },
    summary:
      `Cannot insert pk=${hit.pk} into ${hit.table}: ${hit.childColumn}=${hit.parentPk} ` +
      `references ${hit.parentTable}, but that parent is missing on target and not inserted by ` +
      `this plan (constraint ${hit.constraintName}).`
  }
}

function changeSetPkIndex(
  tables: readonly SyncPlanTable[],
  bucket: "insert" | "delete"
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const table of tables) {
    map.set(table.table, new Set(table.changeSet[bucket].map((row) => row.pk)))
  }
  return map
}

/** All stringified PK-column values from insert rows (for parent coverage checks). */
function changeSetValueIndex(
  tables: readonly SyncPlanTable[],
  bucket: "insert" | "delete"
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const table of tables) {
    const values = new Set<string>()
    for (const row of table.changeSet[bucket]) {
      values.add(row.pk)
      for (const v of Object.values(row.values)) values.add(String(v ?? "∅"))
    }
    map.set(table.table, values)
  }
  return map
}
