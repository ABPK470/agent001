/**
 * Bulk env-pair diff scan — runs the same `previewSync` hash engine as
 * `sync_preview`, once per root entity instance.
 *
 * Discovery is explicit: count instances on source, list every root id,
 * then run a full hash preview per id. No hidden sampling cap.
 */

import { movementOfTable } from "@mia/shared-types"
import { resolveEntityPreviewConcurrency } from "../adapters/mssql/pool-concurrency.js"
import type { SyncEntityId } from "../domain/definition-selection.js"
import { EventType, SyncOperationType } from "../domain/enums.js"
import { assertSupportedSyncDirection, getEnvironment } from "../domain/environments.js"
import {
  assertEnvConnectorReady,
  readyMssqlConnectorIds,
} from "../domain/sync-env-eligibility.js"
import { getPublishedSyncDefinitionForHost, type PublishedSyncDefinition } from "../domain/published-definitions.js"
import type { SyncRuntimeHost } from "../ports/index.js"
import { emitSyncEvent } from "./events.js"
import { mapWithConcurrency, trackedQuery } from "./orchestrator/db-helpers.js"
import { previewSync } from "./orchestrator/preview.js"
import type { SyncPlan } from "./plan-store.js"

export interface SyncDiffScanInput {
  host: SyncRuntimeHost
  entityType: SyncEntityId
  source: string
  target: string
  /** When omitted, every root id on source is discovered and scanned. */
  entityIds?: readonly (string | number)[]
  /**
   * Optional sample limit when listing from source (e.g. after a timeout).
   * Omit to scan the full discovered list.
   */
  maxEntities?: number
  /** When set, only count/report movement on these tables (preview still runs full scope). */
  tables?: readonly string[]
  /** Skip instances with zero movement on the reported tables. Default true. */
  onlyDivergent?: boolean
  force?: boolean
  userUpn?: string | null
}

export interface SyncDiffScanTableTotals {
  readonly table: string
  readonly insert: number
  readonly update: number
  readonly delete: number
}

export interface SyncDiffScanEntityResult {
  readonly entityId: string | number
  readonly displayName: string | null
  readonly planId: string
  readonly totals: { readonly insert: number; readonly update: number; readonly delete: number }
  readonly tables: readonly SyncDiffScanTableTotals[]
  readonly hasConflicts: boolean
}

export interface SyncDiffScanError {
  readonly entityId: string | number
  readonly message: string
}

export interface SyncDiffScanResult {
  readonly source: string
  readonly target: string
  readonly entityType: string
  /** Distinct root instances on source. */
  readonly totalOnSource: number
  /** True when maxEntities limited the discovered list. */
  readonly sampled: boolean
  readonly scanned: number
  readonly divergent: number
  readonly errors: readonly SyncDiffScanError[]
  readonly results: readonly SyncDiffScanEntityResult[]
}

interface RootInstance {
  readonly id: string | number
  readonly label: string | null
}

function normalizeTableName(name: string): string {
  return name.trim().toLowerCase()
}

function tableFilterSet(tables: readonly string[] | undefined): ReadonlySet<string> | null {
  if (!tables?.length) return null
  return new Set(tables.map(normalizeTableName))
}

function movementTables(plan: SyncPlan, filter: ReadonlySet<string> | null): SyncDiffScanTableTotals[] {
  const out: SyncDiffScanTableTotals[] = []
  for (const t of plan.tables) {
    if (filter && !filter.has(normalizeTableName(t.table))) continue
    const m = movementOfTable(t)
    if (m.insert + m.update + m.delete === 0) continue
    out.push({ table: t.table, insert: m.insert, update: m.update, delete: m.delete })
  }
  return out
}

function sumMovement(tables: readonly SyncDiffScanTableTotals[]): {
  insert: number
  update: number
  delete: number
} {
  let insert = 0
  let update = 0
  let del = 0
  for (const t of tables) {
    insert += t.insert
    update += t.update
    del += t.delete
  }
  return { insert, update, delete: del }
}

function parseRootTable(table: string): { schema: string; name: string } {
  const [schema, name] = table.split(".")
  if (!schema || !name) throw new Error(`Invalid root table name: ${table}`)
  return { schema, name }
}

async function countRootInstances(
  host: SyncRuntimeHost,
  conn: string,
  rootTable: string
): Promise<number> {
  const { schema, name } = parseRootTable(rootTable)
  const qt = `[${schema}].[${name}]`
  const sqlText = `SELECT COUNT_BIG(1) AS cnt FROM ${qt} WITH (NOLOCK)`
  const ctx = { kind: SyncOperationType.Preview, opId: `scan-${rootTable}`, scope: "discovery" as const }
  const countR = await trackedQuery<{ cnt: number }>(
    host,
    conn,
    sqlText,
    `discovery.scanCount(${rootTable})`,
    ctx
  )
  return Number(countR.recordset[0]?.cnt ?? 0)
}

async function discoverRootInstances(
  host: SyncRuntimeHost,
  conn: string,
  definition: PublishedSyncDefinition,
  sampleLimit?: number
): Promise<{ instances: RootInstance[]; totalOnSource: number }> {
  const { rootTable, idColumn, labelColumn } = definition
  const { schema, name } = parseRootTable(rootTable)
  const limit =
    sampleLimit != null && Number.isFinite(sampleLimit) && sampleLimit > 0
      ? Math.floor(sampleLimit)
      : undefined

  const ctx = { kind: SyncOperationType.Preview, opId: `scan-${rootTable}`, scope: "discovery" as const }
  const qt = `[${schema}].[${name}]`
  const qid = `[${idColumn}]`
  const countSql = `SELECT COUNT_BIG(1) AS cnt FROM ${qt} WITH (NOLOCK)`
  const countR = await trackedQuery<{ cnt: number }>(host, conn, countSql, `discovery.scanCount(${rootTable})`, ctx)
  const totalOnSource = Number(countR.recordset[0]?.cnt ?? 0)
  const labelSel = labelColumn ? `, [${labelColumn}] AS label` : ""
  const topClause = limit != null ? `TOP (${limit}) ` : ""
  const listSql = `SELECT ${topClause}${qid} AS id${labelSel} FROM ${qt} WITH (NOLOCK) ORDER BY ${qid}`
  const listR = await trackedQuery<{ id: string | number; label?: string | null }>(
    host,
    conn,
    listSql,
    `discovery.scanList(${rootTable})`,
    ctx
  )
  const instances = (listR.recordset ?? []).map((row) => ({
    id: row.id,
    label: labelColumn && row.label != null ? String(row.label) : null
  }))
  return { instances, totalOnSource }
}

export async function syncDiffScan(input: SyncDiffScanInput): Promise<SyncDiffScanResult> {
  const source = input.source.trim()
  const target = input.target.trim()
  const sourceEnv = getEnvironment(input.host, source)
  const targetEnv = getEnvironment(input.host, target)
  const readyIds = readyMssqlConnectorIds(input.host)
  assertEnvConnectorReady(sourceEnv, readyIds)
  assertEnvConnectorReady(targetEnv, readyIds)
  assertSupportedSyncDirection(sourceEnv, targetEnv)

  const definition = getPublishedSyncDefinitionForHost(input.host, input.entityType)
  const onlyDivergent = input.onlyDivergent !== false
  const tableFilter = tableFilterSet(input.tables)
  const sampleLimit =
    input.maxEntities != null && Number.isFinite(input.maxEntities) && input.maxEntities > 0
      ? Math.floor(input.maxEntities)
      : undefined

  let totalOnSource = 0
  let sampled = false
  let instances: RootInstance[]

  if (input.entityIds && input.entityIds.length > 0) {
    totalOnSource = await countRootInstances(input.host, source, definition.rootTable)
    instances = input.entityIds.map((id) => ({ id, label: null }))
    sampled = false
  } else {
    const discovered = await discoverRootInstances(input.host, source, definition, sampleLimit)
    totalOnSource = discovered.totalOnSource
    instances = [...discovered.instances]
    sampled = sampleLimit != null && discovered.totalOnSource > instances.length
  }

  const labelById = new Map(instances.map((row) => [String(row.id), row.label]))
  const candidateIds = instances.map((row) => row.id)

  emitSyncEvent(input.host, EventType.SyncScanDiscovered, {
    entityType: input.entityType,
    source,
    target,
    totalOnSource,
    toScan: candidateIds.length,
    sampled
  })

  const errors: SyncDiffScanError[] = []
  const results: SyncDiffScanEntityResult[] = []

  const entityConcurrency = resolveEntityPreviewConcurrency(input.host, source, target)

  const perEntity = await mapWithConcurrency(
    candidateIds.map((entityId, index) => ({ entityId, index })),
    entityConcurrency,
    async ({ entityId, index }) => {
      emitSyncEvent(input.host, EventType.SyncScanEntityStart, {
        entityIndex: index + 1,
        entityTotal: candidateIds.length,
        totalOnSource,
        sampled,
        entityType: input.entityType,
        entityId,
        entityLabel: labelById.get(String(entityId)) ?? null,
        source,
        target
      })
      try {
        const plan = await previewSync({
          host: input.host,
          entityType: input.entityType,
          entityId,
          source,
          target,
          force: Boolean(input.force),
          userUpn: input.userUpn
        })
        const tables = movementTables(plan, tableFilter)
        const totals = sumMovement(tables)
        const movement = totals.insert + totals.update + totals.delete
        if (onlyDivergent && movement === 0) return { kind: "skip" as const }
        const hasConflicts = plan.tables.some((t) => t.conflicts.length > 0)
        const discoveredLabel = labelById.get(String(entityId))
        return {
          kind: "ok" as const,
          result: {
            entityId,
            displayName: plan.entity.displayName ?? discoveredLabel ?? null,
            planId: plan.planId,
            totals,
            tables,
            hasConflicts
          }
        }
      } catch (e) {
        return {
          kind: "err" as const,
          error: {
            entityId,
            message: e instanceof Error ? e.message : String(e)
          }
        }
      }
    }
  )

  for (const row of perEntity) {
    if (!row) continue
    if (row.kind === "ok") results.push(row.result)
    else if (row.kind === "err") errors.push(row.error)
  }

  results.sort((a, b) => {
    const da = a.totals.insert + a.totals.update + a.totals.delete
    const db = b.totals.insert + b.totals.update + b.totals.delete
    return db - da
  })

  return {
    source,
    target,
    entityType: input.entityType,
    totalOnSource,
    sampled,
    scanned: candidateIds.length,
    divergent: results.length,
    errors,
    results
  }
}
