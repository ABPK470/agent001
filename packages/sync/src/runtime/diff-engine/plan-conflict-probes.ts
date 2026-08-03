/**
 * Post-diff plan conflict probes — single seam for preview.
 *
 * Runs after all table diffs. Owns:
 *   - inbound_reference (delete blocked by out-of-scope FK holders)
 *   - missing_parent (insert blocked by absent parent not in this plan)
 *
 * Scope misattribution stays in per-table diff (no sibling plan state needed).
 * Probe I/O failures become plan warnings — never silent empty success.
 */

import { quoteValue } from "../../core/diff-engine/sql-helpers.js"
import {
  reconcilePlanConflicts,
  type PlanConflictHit
} from "../../core/diff-engine/plan-conflicts.js"
import type { SyncPlanTable } from "../../domain/plan.js"
import type { SyncTelemetryContext } from "../../ports/events.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { resolveWarehouseDialect } from "../warehouse-dialect.js"
import { runQueryWithRetry } from "./sql-query.js"

const CANDIDATE_CAP = 5_000
const HITS_CAP = 5_000

export interface PlanConflictProbeResult {
  tables: SyncPlanTable[]
  /** Plan-level alerts when a probe could not run reliably. */
  probeWarnings: string[]
}

interface ForeignKeyEdge {
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
  constraintName: string
}

export async function applyPlanConflictProbes(
  host: SyncRuntimeHost,
  targetConn: string,
  tables: readonly SyncPlanTable[],
  telemetryContext?: SyncTelemetryContext
): Promise<PlanConflictProbeResult> {
  const hits: PlanConflictHit[] = []
  const probeWarnings: string[] = []

  for (const table of tables) {
    if (table.changeSet.delete.length > 0) {
      const { hits: inboundHits, warnings } = await collectInboundDeleteHits(
        host,
        targetConn,
        table,
        telemetryContext
      )
      hits.push(...inboundHits)
      probeWarnings.push(...warnings)
    }
    if (table.changeSet.insert.length > 0) {
      const { hits: missingHits, warnings } = await collectMissingParentHits(
        host,
        targetConn,
        table,
        tables,
        telemetryContext
      )
      hits.push(...missingHits)
      probeWarnings.push(...warnings)
    }
  }

  return {
    tables: reconcilePlanConflicts(tables, hits),
    probeWarnings
  }
}

/** @deprecated Use applyPlanConflictProbes — kept for one release as alias. */
export async function applyInboundDeleteBlockers(
  host: SyncRuntimeHost,
  targetConn: string,
  tables: readonly SyncPlanTable[],
  telemetryContext?: SyncTelemetryContext
): Promise<SyncPlanTable[]> {
  const result = await applyPlanConflictProbes(host, targetConn, tables, telemetryContext)
  return result.tables
}

async function collectInboundDeleteHits(
  host: SyncRuntimeHost,
  targetConn: string,
  table: SyncPlanTable,
  telemetryContext?: SyncTelemetryContext
): Promise<{ hits: PlanConflictHit[]; warnings: string[] }> {
  const warnings: string[] = []
  const deletes = table.changeSet.delete.slice(0, CANDIDATE_CAP)
  const pkColumns = Object.keys(deletes[0]?.values ?? {})
  if (pkColumns.length !== 1) return { hits: [], warnings }
  const pkCol = pkColumns[0]!

  let inbound: ForeignKeyEdge[]
  try {
    inbound = await fetchInboundForeignKeys(host, targetConn, table.table, pkCol, telemetryContext)
  } catch (e) {
    warnings.push(probeWarning("inbound", table.table, e))
    return { hits: [], warnings }
  }
  if (inbound.length === 0) return { hits: [], warnings }

  const referencingTables = [...new Set(inbound.map((fk) => fk.fromTable))]
  const pkByRef = await fetchPrimaryKeyColumns(host, targetConn, referencingTables, telemetryContext)
  const ownerColsByRef = new Map<string, string[]>()
  for (const refTable of referencingTables) {
    try {
      const outbound = await fetchOutboundForeignKeys(host, targetConn, refTable, telemetryContext)
      ownerColsByRef.set(
        refTable,
        [
          ...new Set(
            outbound
              .filter((fk) => fk.toTable !== table.table)
              .map((fk) => fk.fromColumn)
          )
        ]
      )
    } catch (e) {
      warnings.push(probeWarning("inbound-owners", refTable, e))
      ownerColsByRef.set(refTable, [])
    }
  }

  const pkLiterals = deletes.map((row) => quoteValue(row.values[pkCol])).join(", ")
  const hits: PlanConflictHit[] = []

  for (const fk of inbound) {
    const refPkCols = pkByRef.get(fk.fromTable) ?? []
    if (refPkCols.length === 0) continue
    const ownerCols = ownerColsByRef.get(fk.fromTable) ?? []
    const dialect = resolveWarehouseDialect(host, targetConn)
    const q = (c: string) => dialect.quoteIdent(c)
    const pkSelect = refPkCols.map((c) => `r.${q(c)} AS ${q(`pk_${c}`)}`).join(", ")
    const ownerSelect = ownerCols.map((c) => `r.${q(c)} AS ${q(`owner_${c}`)}`).join(", ")
    const selectList = [pkSelect, `r.${q(fk.fromColumn)} AS blockedPk`, ownerSelect]
      .filter(Boolean)
      .join(", ")

    let result: Awaited<ReturnType<typeof runQueryWithRetry>>
    try {
      result = await runQueryWithRetry(
        host,
        targetConn,
        `SELECT ${dialect.selectLimitPrefixSql(HITS_CAP)}${selectList} FROM ${dialect.quoteTable(fk.fromTable)} r ` +
          `WHERE r.${q(fk.fromColumn)} IN (${pkLiterals})${dialect.selectLimitSuffixSql(HITS_CAP)}`,
        `planConflict.inbound(${table.table}←${fk.fromTable}.${fk.fromColumn})`,
        2,
        telemetryContext
      )
    } catch (e) {
      warnings.push(probeWarning("inbound", `${table.table}←${fk.constraintName}`, e))
      continue
    }

    for (const row of result.recordset as Record<string, unknown>[]) {
      const referencingPk = refPkCols.map((c) => String(row[`pk_${c}`] ?? "∅")).join("|")
      const blockedPk = String(row.blockedPk ?? "∅")
      const matchingDelete = deletes.find((d) => String(d.values[pkCol] ?? "∅") === blockedPk)
      const owners: Record<string, unknown> = {}
      for (const col of ownerCols) {
        const v = row[`owner_${col}`]
        if (v !== null && v !== undefined) owners[col] = v
      }
      hits.push({
        kind: "inbound_reference",
        table: table.table,
        pk: matchingDelete?.pk ?? blockedPk,
        referencingTable: fk.fromTable,
        referencingColumn: fk.fromColumn,
        referencingPk,
        constraintName: fk.constraintName,
        ...(Object.keys(owners).length > 0 ? { owners } : {})
      })
    }
  }

  return { hits, warnings }
}

async function collectMissingParentHits(
  host: SyncRuntimeHost,
  targetConn: string,
  table: SyncPlanTable,
  allTables: readonly SyncPlanTable[],
  telemetryContext?: SyncTelemetryContext
): Promise<{ hits: PlanConflictHit[]; warnings: string[] }> {
  const warnings: string[] = []
  const inserts = table.changeSet.insert.slice(0, CANDIDATE_CAP)
  if (inserts.length === 0) return { hits: [], warnings }

  let outbound: ForeignKeyEdge[]
  try {
    outbound = await fetchOutboundForeignKeys(host, targetConn, table.table, telemetryContext)
  } catch (e) {
    warnings.push(probeWarning("missing-parent", table.table, e))
    return { hits: [], warnings }
  }
  // Single-column FKs only; skip self-FKs (handled by order / same-table inserts).
  outbound = outbound.filter((fk) => fk.toTable !== table.table)
  if (outbound.length === 0) return { hits: [], warnings }

  const insertCoverage = buildInsertCoverage(allTables)
  const hits: PlanConflictHit[] = []

  for (const fk of outbound) {
    const needed = new Map<string, string[]>() // parentPk -> child pks that need it
    for (const row of inserts) {
      const raw = row.values[fk.fromColumn]
      if (raw === null || raw === undefined) continue
      const parentPk = String(raw)
      if (insertCoverage.has(`${fk.toTable}|${parentPk}`)) continue
      const list = needed.get(parentPk) ?? []
      list.push(row.pk)
      needed.set(parentPk, list)
    }
    if (needed.size === 0) continue

    const literals = [...needed.keys()].map((pk) => quoteValue(coerceLiteral(pk))).join(", ")
    let present = new Set<string>()
    try {
      const dialect = resolveWarehouseDialect(host, targetConn)
      const result = await runQueryWithRetry(
        host,
        targetConn,
        `SELECT ${dialect.selectLimitPrefixSql(HITS_CAP)}${dialect.quoteIdent(fk.toColumn)} AS parentPk ` +
          `FROM ${dialect.quoteTable(fk.toTable)} WHERE ${dialect.quoteIdent(fk.toColumn)} IN (${literals})` +
          dialect.selectLimitSuffixSql(HITS_CAP),
        `planConflict.missingParent(${table.table}→${fk.toTable}.${fk.toColumn})`,
        2,
        telemetryContext
      )
      present = new Set(
        (result.recordset as Array<{ parentPk: unknown }>).map((r) => String(r.parentPk ?? "∅"))
      )
    } catch (e) {
      warnings.push(probeWarning("missing-parent", `${table.table}→${fk.constraintName}`, e))
      continue
    }

    for (const [parentPk, childPks] of needed) {
      if (present.has(parentPk)) continue
      for (const childPk of childPks) {
        hits.push({
          kind: "missing_parent",
          table: table.table,
          pk: childPk,
          parentTable: fk.toTable,
          childColumn: fk.fromColumn,
          parentPk,
          constraintName: fk.constraintName
        })
      }
    }
  }

  return { hits, warnings }
}

function buildInsertCoverage(tables: readonly SyncPlanTable[]): Set<string> {
  const set = new Set<string>()
  for (const table of tables) {
    for (const row of table.changeSet.insert) {
      set.add(`${table.table}|${row.pk}`)
      for (const v of Object.values(row.values)) {
        if (v !== null && v !== undefined) set.add(`${table.table}|${String(v)}`)
      }
    }
  }
  return set
}

function coerceLiteral(pk: string): string | number {
  if (/^-?\d+$/.test(pk)) return Number(pk)
  return pk
}

function probeWarning(probe: string, subject: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `[conflict-probe] ${probe} failed for ${subject}: ${message}`
}

async function fetchInboundForeignKeys(
  host: SyncRuntimeHost,
  connectionName: string,
  qualifiedTable: string,
  referencedColumn: string,
  telemetryContext?: SyncTelemetryContext
): Promise<ForeignKeyEdge[]> {
  const dialect = resolveWarehouseDialect(host, connectionName)
  const result = await runQueryWithRetry(
    host,
    connectionName,
    dialect.inboundForeignKeysSql(qualifiedTable),
    `fetchInboundForeignKeys(${qualifiedTable})`,
    2,
    telemetryContext
  )
  return mapSingleColumnEdges(result.recordset, referencedColumn)
}

async function fetchOutboundForeignKeys(
  host: SyncRuntimeHost,
  connectionName: string,
  qualifiedTable: string,
  telemetryContext?: SyncTelemetryContext
): Promise<ForeignKeyEdge[]> {
  const dialect = resolveWarehouseDialect(host, connectionName)
  const result = await runQueryWithRetry(
    host,
    connectionName,
    dialect.outboundForeignKeysSql(qualifiedTable),
    `fetchOutboundForeignKeys(${qualifiedTable})`,
    2,
    telemetryContext
  )
  return mapSingleColumnEdges(result.recordset, null)
}

function mapSingleColumnEdges(
  recordset: unknown,
  requiredToColumn: string | null
): ForeignKeyEdge[] {
  const out: ForeignKeyEdge[] = []
  for (const row of recordset as Array<{
    fromSchema: string
    fromName: string
    fromColumn: string
    toSchema: string
    toName: string
    toColumn: string
    constraintName: string
    fkColumnCount: number
  }>) {
    if (Number(row.fkColumnCount) !== 1) continue
    if (requiredToColumn && row.toColumn !== requiredToColumn) continue
    if (!row.fromSchema || !row.fromName || !row.toSchema || !row.toName) continue
    out.push({
      fromTable: `${row.fromSchema}.${row.fromName}`,
      fromColumn: row.fromColumn,
      toTable: `${row.toSchema}.${row.toName}`,
      toColumn: row.toColumn,
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
      const dialect = resolveWarehouseDialect(host, connectionName)
      const r = await runQueryWithRetry(
        host,
        connectionName,
        dialect.primaryKeySql(qn),
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
