/**
 * Map diff-engine PK rows to `SyncPlanChangeSet` on each plan table.
 *
 * @module
 */

import type { SyncPlanChangeRow, SyncPlanChangeSet } from "../../domain/plan.js"
import type { PkHashRow } from "../../domain/diff-engine/types.js"

export function emptyChangeSet(): SyncPlanChangeSet {
  return { insert: [], update: [], delete: [] }
}

export function buildChangeSet(
  inserts: readonly PkHashRow[],
  updates: readonly PkHashRow[],
  deletes: readonly PkHashRow[]
): SyncPlanChangeSet {
  return {
    insert: toChangeRows(inserts),
    update: toChangeRows(updates),
    delete: toChangeRows(deletes)
  }
}

function toChangeRows(rows: readonly PkHashRow[]): SyncPlanChangeRow[] {
  return rows.map((row) => ({ pk: row.pk, values: { ...row.pkValues } }))
}
