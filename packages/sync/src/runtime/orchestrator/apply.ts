/**
 * MERGE / DELETE primitives for the sync orchestrator.
 *
 * Rows to apply come exclusively from `SyncPlanTable.changeSet` produced at preview.
 *
 * @module
 */

import { type Transaction } from "mssql"
import type { Scd2TablePolicy } from "@mia/shared-types"
import {
  materializeScd2PolicyForSchema,
} from "../../core/entity-registry/scd2-policy.js"
import { buildBatchWhere } from "../../core/diff-engine/sql-helpers.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import type { SyncTelemetryContext } from "../events.js"
import { resolveWarehouseDialect } from "../warehouse-dialect.js"
import { type SyncPlan, type SyncPlanTable } from "../plan-store.js"
import { deleteRows, changeRowsAsPkHash, upsertRows } from "./plan-table.js"
import { qtable, trackedQuery } from "./db/db-helpers.js"

const CHANGE_SET_FETCH_BATCH = 200

function requireScd2Policy(plan: SyncPlan, tableName: string): Scd2TablePolicy {
  const row = plan.executionContract.metadata.tables.find((t) => t.name === tableName)
  if (!row?.scd2Policy) {
    throw new Error(`Missing scd2Policy for ${tableName} — republish the sync definition.`)
  }
  return row.scd2Policy
}

async function fetchSourceRowsForUpsert(
  host: SyncRuntimeHost,
  plan: SyncPlan,
  tableName: string,
  tableResult: SyncPlanTable,
  pkColumns: string[],
  telemetryContext?: SyncTelemetryContext
): Promise<Record<string, unknown>[]> {
  const upsertKeys = upsertRows(tableResult)
  if (upsertKeys.length === 0) return []

  const pkRows = changeRowsAsPkHash(upsertKeys)
  const rows: Record<string, unknown>[] = []

  for (let i = 0; i < pkRows.length; i += CHANGE_SET_FETCH_BATCH) {
    const batch = pkRows.slice(i, i + CHANGE_SET_FETCH_BATCH)
    const where = buildBatchWhere(batch, pkColumns)
    const batchResult = await trackedQuery(
      host,
      plan.source,
      `SELECT * FROM ${qtable(tableName)} WHERE ${where}`,
      `applyInsertsUpdates.readChangeSet(${tableName})`,
      telemetryContext
    )
    rows.push(...(batchResult.recordset as Record<string, unknown>[]))
  }
  return rows
}

/**
 * Discover PK columns for the supplied target tables (one query per table).
 * Returns a map keyed by `schema.table`. Tables without a PK get an empty
 * array — callers must guard against that before issuing MERGE / DELETE.
 */
export async function fetchPkColumns(
  host: SyncRuntimeHost,
  connection: string,
  tables: string[],
  telemetryContext?: SyncTelemetryContext
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (tables.length === 0) return result
  const dialect = resolveWarehouseDialect(host, connection)
  for (const qn of tables) {
    const [schema, name] = qn.split(".")
    if (!schema || !name) continue
    try {
      const r = await trackedQuery(
        host,
        connection,
        dialect.primaryKeySql(qn),
        `fetchPkColumns(${qn})`,
        telemetryContext
      )
      result.set(
        qn,
        (r.recordset as Array<{ name: string }>).map((row) => row.name)
      )
    } catch {
      result.set(qn, [])
    }
  }
  return result
}

/**
 * Apply inserts + updates by reading source rows via the source pool and
 * writing them to the target via a temp table + MERGE.
 * Column exclusions and stamp expressions come from the schema-grounded
 * `scd2Policy` frozen on the plan at preview time.
 */
export async function applyInsertsUpdates(
  host: SyncRuntimeHost,
  tx: Transaction,
  plan: SyncPlan,
  tableName: string,
  pkColumns: string[],
  telemetryContext?: SyncTelemetryContext
): Promise<number> {
  const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
  if (!tableResult) return 0
  if (pkColumns.length === 0) throw new Error(`No PK for ${tableName} — cannot MERGE.`)

  const rows = await fetchSourceRowsForUpsert(
    host,
    plan,
    tableName,
    tableResult,
    pkColumns,
    telemetryContext
  )
  if (rows.length === 0) return 0

  const dialect = resolveWarehouseDialect(host, plan.target)
  // Discover columns from target metadata (not source row keys — schemas may diverge).
  const colResult = await trackedQuery(
    host,
    plan.target,
    dialect.targetColumnsSql(tableName),
    `applyInsertsUpdates.cols(${tableName})`,
    telemetryContext,
    tx.request()
  )
  const targetCols = colResult.recordset as Array<{
    name: string
    is_identity: boolean
    is_computed: boolean
  }>
  const policy = materializeScd2PolicyForSchema(
    requireScd2Policy(plan, tableName),
    Object.keys(rows[0]!),
    targetCols.map((c) => c.name),
  ).policy
  const excluded = new Set(policy.excludeFromDiff)
  const identityCol = targetCols.find((c) => c.is_identity)?.name ?? null
  const onInsertStamps = policy.onInsert
  const onUpdateStamps = policy.onUpdate
  const allSourceCols = new Set(Object.keys(rows[0]))
  const omitIdentity = policy.identityHandling === "omit-identity-column"

  const allSyncCols = targetCols
    .filter((c) => allSourceCols.has(c.name) && !c.is_computed)
    .map((c) => c.name)

  const tempCols = allSyncCols.filter((c) => {
    if (excluded.has(c)) return false
    if (omitIdentity && c === identityCol) return false
    return true
  })
  if (tempCols.length === 0) throw new Error(`No overlapping data columns for ${tableName}.`)

  const pkSet = new Set(pkColumns)
  const updateCols = tempCols.filter((c) => !pkSet.has(c) && c !== identityCol)
  const allowUpdate = tableResult.changeSet.update.length > 0
  const useIdentityInsert =
    Boolean(identityCol)
    && !omitIdentity
    && (policy.identityHandling === "setIdentityInsertOn" || policy.identityHandling === "none")

  const fullSql = dialect.upsertBatchSql({
    table: tableName,
    pkColumns,
    tempCols,
    updateCols,
    identityCol,
    useIdentityInsert,
    allowUpdate,
    rows,
    onInsertStamps,
    onUpdateStamps,
  })

  const result = await trackedQuery(
    host,
    plan.target,
    fullSql,
    `applyInsertsUpdates.merge(${tableName})`,
    telemetryContext,
    tx.request()
  )
  // rowsAffected: last meaningful entry is the MERGE itself
  const raIdx = result.rowsAffected.length - 2
  return (result.rowsAffected[raIdx] as number | undefined) ?? 0
}

/**
 * Apply deletes from changeSet — target rows absent on source.
 */
export async function applyDeletes(
  host: SyncRuntimeHost,
  tx: Transaction,
  plan: SyncPlan,
  tableName: string,
  pkColumns: string[],
  telemetryContext?: SyncTelemetryContext
): Promise<number> {
  const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
  if (!tableResult) return 0
  if (pkColumns.length === 0) throw new Error(`No PK for ${tableName} — cannot delete.`)

  const deleteKeys = deleteRows(tableResult)
  if (deleteKeys.length === 0) return 0

  const pkRows = changeRowsAsPkHash(deleteKeys)
  const dialect = resolveWarehouseDialect(host, plan.target)
  const fullSql = dialect.deleteBatchSql({
    table: tableName,
    pkColumns,
    rows: pkRows.map((r) => r.pkValues),
  })

  const result = await trackedQuery(
    host,
    plan.target,
    fullSql,
    `applyDeletes.execChangeSet(${tableName})`,
    telemetryContext,
    tx.request()
  )
  const raIdx = result.rowsAffected.length - 2
  return (result.rowsAffected[raIdx] as number | undefined) ?? 0
}
