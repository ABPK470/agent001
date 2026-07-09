/**
 * Universal root-parent preflight for any entity sync plan.
 *
 * Invariant: when the plan upserts non-root children, the root row for
 * `plan.entity.id` must already exist on target OR be inserted by this plan
 * on `executionContract.metadata.rootTable`.
 *
 * Derived only from the frozen execution contract — no hardcoded tables.
 */

import type { SyncRuntimeHost } from "../../../ports/index.js"
import type { SyncPlan } from "../plan-store.js"
import { hasUpsertWork } from "./plan-table.js"
import { qtable, trackedQuery } from "./db-helpers.js"

export interface RootParentPreflightResult {
  ready: boolean
  /** Set when `ready` is false. */
  issue: string | null
  /** Diagnostic fields for decision logs / tests. */
  details: {
    rootTable: string
    rootKeyColumn: string
    entityId: string | number
    requiresRootOnTarget: boolean
    rootInsertPlanned: boolean
    rootPresentOnTarget: boolean | null
  }
}

export function entityIdMatches(left: unknown, right: string | number): boolean {
  if (left === right) return true
  const leftNum = Number(left)
  const rightNum = Number(right)
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && leftNum === rightNum) return true
  return String(left ?? "") === String(right)
}

/** True when any recipe child table has insert/update work. */
export function planRequiresRootOnTarget(plan: SyncPlan): boolean {
  const rootTable = plan.executionContract.metadata.rootTable
  const recipeTables = new Set(plan.executionContract.metadata.tables.map((t) => t.name))
  return plan.tables.some(
    (row) => row.table !== rootTable && recipeTables.has(row.table) && hasUpsertWork(row)
  )
}

/** True when the plan inserts the synced entity on the root table. */
export function planInsertsRootEntity(plan: SyncPlan): boolean {
  const { rootTable, rootKeyColumn } = plan.executionContract.metadata
  const entityId = plan.entity.id
  const rootRow = plan.tables.find((t) => t.table === rootTable)
  if (!rootRow?.changeSet) return false
  return rootRow.changeSet.insert.some((row) => entityIdMatches(row.values[rootKeyColumn], entityId))
}

function sqlLiteralEntityId(entityId: string | number): string {
  return typeof entityId === "number" ? String(entityId) : `'${String(entityId).replace(/'/g, "''")}'`
}

export async function targetRootExists(
  host: SyncRuntimeHost,
  targetConn: string,
  rootTable: string,
  rootKeyColumn: string,
  entityId: string | number
): Promise<boolean> {
  const idLiteral = sqlLiteralEntityId(entityId)
  const result = await trackedQuery(
    host,
    targetConn,
    `SELECT TOP 1 1 AS ok FROM ${qtable(rootTable)} WHERE [${rootKeyColumn}] = ${idLiteral}`,
    `rootParent.exists(${rootTable})`
  )
  return (result.recordset as Array<{ ok: number }>).length > 0
}

export async function evaluateRootParentPreflight(
  host: SyncRuntimeHost,
  targetConn: string,
  plan: SyncPlan
): Promise<RootParentPreflightResult> {
  const { rootTable, rootKeyColumn } = plan.executionContract.metadata
  const entityId = plan.entity.id
  const requiresRootOnTarget = planRequiresRootOnTarget(plan)
  const rootInsertPlanned = planInsertsRootEntity(plan)

  const baseDetails = {
    rootTable,
    rootKeyColumn,
    entityId,
    requiresRootOnTarget,
    rootInsertPlanned,
    rootPresentOnTarget: null as boolean | null
  }

  if (!requiresRootOnTarget) {
    return { ready: true, issue: null, details: baseDetails }
  }

  if (rootInsertPlanned) {
    return {
      ready: true,
      issue: null,
      details: { ...baseDetails, rootPresentOnTarget: null }
    }
  }

  const rootPresentOnTarget = await targetRootExists(host, targetConn, rootTable, rootKeyColumn, entityId)
  if (rootPresentOnTarget) {
    return {
      ready: true,
      issue: null,
      details: { ...baseDetails, rootPresentOnTarget: true }
    }
  }

  const issue =
    `Target is missing ${rootTable} row for ${rootKeyColumn}=${entityId}. ` +
    `Child upserts in this plan require the root parent on target — include ${rootTable} in the plan (insert on source) or create the row on target before execute.`

  return {
    ready: false,
    issue,
    details: { ...baseDetails, rootPresentOnTarget: false }
  }
}

export function formatRootParentExecuteRefusal(issue: string): string {
  return (
    `Missing root parent on target — refusing to execute. ${issue} ` +
    `Re-preview after the root row exists on target or is included as an insert in this plan.`
  )
}
