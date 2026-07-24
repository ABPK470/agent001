/**
 * Preview probe: inbound FK references that would block delete of changeSet PKs.
 *
 * Discovers referencing tables via sys.foreign_keys on TARGET, then samples rows
 * that still point at delete candidates. Does not widen entity scope — hits are
 * reconciled into conflicts (see reconcileInboundDeleteBlockers).
 */

import { qtable, quoteValue } from "../../core/diff-engine/sql-helpers.js"
import {
  reconcileInboundDeleteBlockers,
  type InboundDeleteHit
} from "../../core/diff-engine/reconcile-inbound-delete-blockers.js"
import type { SyncPlanTable } from "../../domain/plan.js"
import type { SyncTelemetryContext } from "../../ports/events.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { runQueryWithRetry } from "./sql-query.js"

const DELETE_CANDIDATE_CAP = 5_000
const HITS_PER_FK_CAP = 5_000

interface InboundForeignKey {
  referencingTable: string
  referencingColumn: string
  referencedColumn: string
  constraintName: string
}

export async function applyInboundDeleteBlockers(
  host: SyncRuntimeHost,
  targetConn: string,
  tables: readonly SyncPlanTable[],
  telemetryContext?: SyncTelemetryContext
): Promise<SyncPlanTable[]> {
  const hits: InboundDeleteHit[] = []

  for (const table of tables) {
    if (table.changeSet.delete.length === 0) continue
    const tableHits = await collectHitsForTable(host, targetConn, table, telemetryContext)
    hits.push(...tableHits)
  }

  return reconcileInboundDeleteBlockers(tables, hits)
}

async function collectHitsForTable(
  host: SyncRuntimeHost,
  targetConn: string,
  table: SyncPlanTable,
  telemetryContext?: SyncTelemetryContext
): Promise<InboundDeleteHit[]> {
  const deletes = table.changeSet.delete.slice(0, DELETE_CANDIDATE_CAP)
  if (deletes.length === 0) return []

  // Infer single PK column from changeSet values (composite → skip; same limit as scope probe).
  const pkColumns = Object.keys(deletes[0]?.values ?? {})
  if (pkColumns.length !== 1) return []
  const pkCol = pkColumns[0]!

  let foreignKeys: InboundForeignKey[]
  try {
    foreignKeys = await fetchInboundForeignKeys(host, targetConn, table.table, pkCol, telemetryContext)
  } catch (e) {
    console.warn(`[sync.diff] inbound FK discovery failed for ${table.table}:`, e)
    return []
  }
  if (foreignKeys.length === 0) return []

  const referencingTables = [...new Set(foreignKeys.map((fk) => fk.referencingTable))]
  const pkByReferencing = await fetchPrimaryKeyColumns(host, targetConn, referencingTables, telemetryContext)

  const pkLiterals = deletes.map((row) => quoteValue(row.values[pkCol])).join(", ")
  const hits: InboundDeleteHit[] = []

  for (const fk of foreignKeys) {
    const refPkCols = pkByReferencing.get(fk.referencingTable) ?? []
    if (refPkCols.length === 0) continue

    const pkSelect = refPkCols.map((c) => `r.[${c}] AS [pk_${c}]`).join(", ")
    const sql =
      `SELECT TOP (${HITS_PER_FK_CAP}) ${pkSelect}, ` +
      `r.[${fk.referencingColumn}] AS blockedPk ` +
      `FROM ${qtable(fk.referencingTable)} r ` +
      `WHERE r.[${fk.referencingColumn}] IN (${pkLiterals})`

    let result: Awaited<ReturnType<typeof runQueryWithRetry>>
    try {
      result = await runQueryWithRetry(
        host,
        targetConn,
        sql,
        `detectInboundDeleteBlockers(${table.table}←${fk.referencingTable}.${fk.referencingColumn})`,
        2,
        telemetryContext
      )
    } catch (e) {
      console.warn(
        `[sync.diff] inbound delete probe failed for ${fk.constraintName} on ${table.table}:`,
        e
      )
      continue
    }

    for (const row of result.recordset as Record<string, unknown>[]) {
      const referencingPk = refPkCols.map((c) => String(row[`pk_${c}`] ?? "∅")).join("|")
      const blockedPk = String(row.blockedPk ?? "∅")
      const matchingDelete = deletes.find((d) => String(d.values[pkCol] ?? "∅") === blockedPk)
      hits.push({
        deletedTable: table.table,
        deletedPk: matchingDelete?.pk ?? blockedPk,
        referencingTable: fk.referencingTable,
        referencingColumn: fk.referencingColumn,
        referencingPk,
        constraintName: fk.constraintName
      })
    }
  }

  return hits
}

async function fetchInboundForeignKeys(
  host: SyncRuntimeHost,
  connectionName: string,
  qualifiedTable: string,
  referencedColumn: string,
  telemetryContext?: SyncTelemetryContext
): Promise<InboundForeignKey[]> {
  const objectIdLiteral = qualifiedTable.replace(/'/g, "''")
  const result = await runQueryWithRetry(
    host,
    connectionName,
    `
    SELECT
      OBJECT_SCHEMA_NAME(fk.parent_object_id) AS referencingSchema,
      OBJECT_NAME(fk.parent_object_id) AS referencingName,
      COL_NAME(fc.parent_object_id, fc.parent_column_id) AS referencingColumn,
      COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS referencedColumn,
      fk.name AS constraintName,
      (
        SELECT COUNT(*)
        FROM sys.foreign_key_columns x
        WHERE x.constraint_object_id = fk.object_id
      ) AS fkColumnCount
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = fk.object_id
    WHERE fk.referenced_object_id = OBJECT_ID(N'${objectIdLiteral}')
    `,
    `fetchInboundForeignKeys(${qualifiedTable})`,
    2,
    telemetryContext
  )

  const out: InboundForeignKey[] = []
  for (const row of result.recordset as Array<{
    referencingSchema: string
    referencingName: string
    referencingColumn: string
    referencedColumn: string
    constraintName: string
    fkColumnCount: number
  }>) {
    if (Number(row.fkColumnCount) !== 1) continue
    if (row.referencedColumn !== referencedColumn) continue
    if (!row.referencingSchema || !row.referencingName) continue
    out.push({
      referencingTable: `${row.referencingSchema}.${row.referencingName}`,
      referencingColumn: row.referencingColumn,
      referencedColumn: row.referencedColumn,
      constraintName: row.constraintName
    })
  }
  return out
}

async function fetchPrimaryKeyColumns(
  host: SyncRuntimeHost,
  connectionName: string,
  tables: string[],
  telemetryContext?: SyncTelemetryContext
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  for (const qn of tables) {
    const [schema, name] = qn.split(".")
    if (!schema || !name) continue
    try {
      const r = await runQueryWithRetry(
        host,
        connectionName,
        `
        SELECT c.name
        FROM sys.indexes i
        JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
        JOIN sys.columns c        ON c.object_id  = ic.object_id AND c.column_id = ic.column_id
        WHERE i.is_primary_key = 1
          AND i.object_id = OBJECT_ID('${schema.replace(/'/g, "''")}.${name.replace(/'/g, "''")}')
        ORDER BY ic.key_ordinal
        `,
        `fetchPrimaryKeyColumns(${qn})`,
        2,
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
