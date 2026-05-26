/**
 * MERGE / DELETE primitives for the sync orchestrator.
 *
 * Each function operates within an open `Transaction` opened by the
 * caller (the execute pipeline). Source rows are read via direct
 * connection pools — no linked-server dependency.
 *
 * @module
 */

import { type Transaction } from "mssql"
import type { AgentHost } from "../../application/shell/runtime.js"
import { getPool } from "../../tools/index.js"
import { type SyncPlan, type SyncPlanTable } from "../plan-store.js"
import type { SyncSqlTraceContext } from "../sync-events.js"
import { qtable, sqlLiteral, trackedQuery } from "./db-helpers.js"

/**
 * Columns excluded from MERGE UPDATE SET / INSERT VALUES — mirrors the legacy
 * core.uspSyncObjectTran exclusion list. These are managed columns that get
 * set explicitly (validFrom = GETUTCDATE(), validTo = NULL) rather than
 * blindly copied from the source environment.
 */
const SYNC_META_COLUMNS = new Set([
  "validFrom",
  "validTo",
  "isLocked",
  "syncDate",
  "deployDate",
])

/**
 * Discover PK columns for the supplied target tables (one query per table).
 * Returns a map keyed by `schema.table`. Tables without a PK get an empty
 * array — callers must guard against that before issuing MERGE / DELETE.
 */
export async function fetchPkColumns(host: AgentHost, connection: string, tables: string[], syncTrace: SyncSqlTraceContext | null = null): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (tables.length === 0) return result
  const { pool } = await getPool(host, connection)
  for (const qn of tables) {
    const [schema, name] = qn.split(".")
    if (!schema || !name) continue
    try {
      const r = await pool.request().query(`
        SELECT c.name
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c        ON c.object_id  = ic.object_id AND c.column_id = ic.column_id
        WHERE i.is_primary_key = 1
          AND i.object_id = OBJECT_ID('${schema}.${name}')
        ORDER BY ic.key_ordinal
      `)
      result.set(qn, r.recordset.map((row: { name: string }) => row.name))
    } catch {
      result.set(qn, [])
    }
  }
  return result
}

/**
 * Apply inserts + updates by reading source rows via the source pool and
 * writing them to the target via a temp table + MERGE.
 * No linked-server dependency — uses direct connection pools.
 *
 * Uses MERGE (not DELETE+INSERT) because parent rows may have FK references
 * from child tables that prevent deletion.
 *
 * Meta columns (validFrom, validTo, isLocked, syncDate, deployDate) are NOT
 * copied from source — instead validFrom=GETUTCDATE(), validTo=NULL on both
 * INSERT and UPDATE, matching the legacy core.uspSyncObjectTran behaviour.
 */
export async function applyInsertsUpdates(
  host: AgentHost,
  tx: Transaction,
  plan: SyncPlan,
  tableName: string,
  pkColumns: string[],
  syncTrace: SyncSqlTraceContext | null = null,
): Promise<number> {
  const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
  if (!tableResult) return 0
  const predicate = tableResult.scopePredicate
  if (pkColumns.length === 0) throw new Error(`No PK for ${tableName} — cannot MERGE.`)

  // 1. Read source rows via source pool (direct connection, no linked server).
  const { pool: srcPool } = await getPool(host, plan.source)
  const srcResult = await trackedQuery(
    host,
    srcPool.request(),
    `SELECT * FROM ${qtable(tableName)} WHERE ${predicate}`,
    `applyInsertsUpdates.read(${tableName})`,
    plan.source,
    syncTrace,
  )
  const rows = srcResult.recordset as Record<string, unknown>[]
  if (rows.length === 0) return 0

  // 2. Discover columns from target metadata (not source row keys — schemas may diverge).
  const colResult = await trackedQuery(
    host,
    tx.request(),
    `
    SELECT c.name, c.is_identity, c.is_computed
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID('${tableName.replace(/'/g, "''")}')
    ORDER BY c.column_id
  `,
    `applyInsertsUpdates.cols(${tableName})`,
    plan.target,
    syncTrace,
  )
  const targetCols = colResult.recordset as Array<{ name: string; is_identity: boolean; is_computed: boolean }>
  const identityCol = targetCols.find((c) => c.is_identity)?.name ?? null
  const allSourceCols = new Set(Object.keys(rows[0]))

  // Which target columns actually exist in source?
  const allSyncCols = targetCols
    .filter((c) => allSourceCols.has(c.name) && !c.is_computed)
    .map((c) => c.name)

  // Temp table: ALL overlapping columns including identity (for PK joins)
  // but excluding meta columns (we never copy them from source).
  const tempCols = allSyncCols.filter((c) => !SYNC_META_COLUMNS.has(c))
  if (tempCols.length === 0) throw new Error(`No overlapping data columns for ${tableName}.`)

  // Columns for the MERGE UPDATE SET — exclude PK (can't update), identity, meta
  const pkSet = new Set(pkColumns)
  const updateCols = tempCols.filter((c) => !pkSet.has(c) && c !== identityCol)

  // Does the target have validFrom / validTo columns?
  const hasValidFrom = allSyncCols.includes("validFrom")
  const hasValidTo = allSyncCols.includes("validTo")

  const pkOn = pkColumns.map((c) => `T.[${c}] = S.[${c}]`).join(" AND ")

  // 3. Build temp table, insert source rows, then MERGE — all in one batch.
  const BATCH = 500
  const batches: string[] = []
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH)
    const valuesList = batch.map((row) => {
      const vals = tempCols.map((c) => sqlLiteral(row[c]))
      return `(${vals.join(", ")})`
    }).join(",\n")
    batches.push(
      `INSERT INTO #syncSrc (${tempCols.map((c) => `[${c}]`).join(", ")}) VALUES ${valuesList}`,
    )
  }

  const tempColList = tempCols.map((c) => `[${c}]`).join(", ")
  // Self-join trick: strips IDENTITY property from the temp table.
  const tempCreate = identityCol
    ? `SELECT TOP 0 ${tempCols.map((c) => `a.[${c}]`).join(", ")} INTO #syncSrc FROM ${qtable(tableName)} a LEFT JOIN ${qtable(tableName)} b ON 1 = 0`
    : `SELECT TOP 0 ${tempColList} INTO #syncSrc FROM ${qtable(tableName)}`

  // Build MERGE UPDATE SET — data cols from source + SCD2 meta reset
  const updateParts: string[] = updateCols.map((c) => `T.[${c}] = S.[${c}]`)
  if (hasValidFrom) updateParts.push("T.[validFrom] = GETUTCDATE()")
  if (hasValidTo) updateParts.push("T.[validTo] = NULL")
  const updateSet = updateParts.length > 0
    ? `WHEN MATCHED THEN UPDATE SET ${updateParts.join(", ")}`
    : ""

  // Build MERGE INSERT — data cols + SCD2 meta
  const insertTargetCols = [...tempCols]
  const insertValueExprs = [...tempCols.map((c) => `S.[${c}]`)]
  if (hasValidFrom) { insertTargetCols.push("validFrom"); insertValueExprs.push("GETUTCDATE()") }
  if (hasValidTo)   { insertTargetCols.push("validTo");   insertValueExprs.push("NULL") }
  const insertTarget = insertTargetCols.map((c) => `[${c}]`).join(", ")
  const insertValues = insertValueExprs.join(", ")

  const mergeStmt = [
    identityCol ? `SET IDENTITY_INSERT ${qtable(tableName)} ON` : null,
    `MERGE ${qtable(tableName)} AS T`,
    `USING #syncSrc AS S ON ${pkOn}`,
    updateSet,
    `WHEN NOT MATCHED BY TARGET THEN INSERT (${insertTarget}) VALUES (${insertValues})`,
    `;`,
    identityCol ? `SET IDENTITY_INSERT ${qtable(tableName)} OFF` : null,
  ].filter(Boolean).join("\n")

  const fullSql = [
    tempCreate,
    ...batches,
    mergeStmt,
    `DROP TABLE #syncSrc`,
  ].join(";\n")

  const result = await trackedQuery(
    host,
    tx.request(),
    fullSql,
    `applyInsertsUpdates.merge(${tableName})`,
    plan.target,
    syncTrace,
  )
  // rowsAffected: last meaningful entry is the MERGE itself
  const raIdx = result.rowsAffected.length - 2
  return (result.rowsAffected[raIdx] as number | undefined) ?? 0
}

/**
 * Apply deletes: rows on target within scope that no longer exist on source.
 * Uses direct source pool — no linked server needed.
 */
export async function applyDeletes(
  host: AgentHost,
  tx: Transaction,
  plan: SyncPlan,
  tableName: string,
  pkColumns: string[],
  syncTrace: SyncSqlTraceContext | null = null,
): Promise<number> {
  const tableResult = plan.tables.find((t: SyncPlanTable) => t.table === tableName)
  if (!tableResult) return 0
  const predicate = tableResult.scopePredicate
  if (pkColumns.length === 0) throw new Error(`No PK for ${tableName} — cannot delete.`)

  // 1. Read source PKs.
  const { pool: srcPool } = await getPool(host, plan.source)
  const pkSelect = pkColumns.map((c) => `[${c}]`).join(", ")
  const srcResult = await trackedQuery(
    host,
    srcPool.request(),
    `SELECT ${pkSelect} FROM ${qtable(tableName)} WHERE ${predicate}`,
    `applyDeletes.read(${tableName})`,
    plan.source,
    syncTrace,
  )
  const srcRows = srcResult.recordset as Record<string, unknown>[]

  // 2. Build full SQL batch: create temp → insert PKs → delete → drop
  const BATCH = 500
  const batches: string[] = []
  for (let i = 0; i < srcRows.length; i += BATCH) {
    const batch = srcRows.slice(i, i + BATCH)
    const valuesList = batch.map((row) => {
      const vals = pkColumns.map((c) => sqlLiteral(row[c]))
      return `(${vals.join(", ")})`
    }).join(",\n")
    batches.push(
      `INSERT INTO #syncSrcPk (${pkColumns.map((c) => `[${c}]`).join(", ")}) VALUES ${valuesList}`,
    )
  }

  const pkOn = pkColumns.map((c) => `T.[${c}] = S.[${c}]`).join(" AND ")
  // Self-join trick strips IDENTITY property so we can INSERT explicit PK values.
  const tempCreate = `SELECT TOP 0 ${pkColumns.map((c) => `a.[${c}]`).join(", ")} INTO #syncSrcPk FROM ${qtable(tableName)} a LEFT JOIN ${qtable(tableName)} b ON 1 = 0`
  // Use CTE to scope the DELETE to rows matching the predicate — avoids fragile
  // regex column-aliasing that breaks on subquery predicates.
  const fullSql = [
    tempCreate,
    ...batches,
    `;WITH Scoped AS (SELECT ${pkSelect} FROM ${qtable(tableName)} WHERE ${predicate})
     DELETE T FROM Scoped T
     LEFT JOIN #syncSrcPk S ON ${pkOn}
     WHERE S.[${pkColumns[0]}] IS NULL`,
    `DROP TABLE #syncSrcPk`,
  ].join(";\n")

  const result = await trackedQuery(
    host,
    tx.request(),
    fullSql,
    `applyDeletes.exec(${tableName})`,
    plan.target,
    syncTrace,
  )
  // The DELETE is the second-to-last statement (before DROP)
  const raIdx = result.rowsAffected.length - 2
  return (result.rowsAffected[raIdx] as number | undefined) ?? 0
}
