import type { AuthoredSyncFlowStep } from "@mia/shared-types"
import { loadSyncMetadataArtifact, parseKindDefinition, parsePhaseDefinition } from "@mia/sync"
import { resolve } from "node:path"

import {
  buildFlowCatalogFromSyncMetadataDoc,
  parseStoredFlowStepsJson,
  prepareFlowStepsForStorage,
} from "../sync-flow-steps.js"
import { getDb } from "../connection.js"

const DEFAULT_TENANT = "_default"

export interface DbSyncPhase {
  tenant_id: string
  id: string
  label: string
  sort_order: number
  built_in: number
  definition_json: string
}

export interface DbSyncAction {
  tenant_id: string
  id: string
  label: string
  built_in: number
  definition_json: string
}

export interface DbSyncFlow {
  tenant_id: string
  id: string
  label: string
  description: string
  steps_json: string
  built_in: number
  updated_at: string
  updated_by: string | null
}

export function listSyncPhases(tenantId = DEFAULT_TENANT): DbSyncPhase[] {
  return getDb()
    .prepare(
      "SELECT tenant_id, id, label, sort_order, built_in, definition_json FROM sync_phases WHERE tenant_id = ? ORDER BY sort_order, id"
    )
    .all(tenantId) as DbSyncPhase[]
}

export function listSyncActions(tenantId = DEFAULT_TENANT): DbSyncAction[] {
  return getDb()
    .prepare(
      "SELECT tenant_id, id, label, built_in, definition_json FROM sync_actions WHERE tenant_id = ? ORDER BY id"
    )
    .all(tenantId) as DbSyncAction[]
}

export function listSyncFlows(tenantId = DEFAULT_TENANT): DbSyncFlow[] {
  return getDb()
    .prepare(
      "SELECT tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by FROM sync_flows WHERE tenant_id = ? ORDER BY built_in DESC, id"
    )
    .all(tenantId) as DbSyncFlow[]
}

export function getSyncFlow(tenantId: string, id: string): DbSyncFlow | null {
  return (
    (getDb()
      .prepare(
        "SELECT tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by FROM sync_flows WHERE tenant_id = ? AND id = ?"
      )
      .get(tenantId, id) as DbSyncFlow | undefined) ?? null
  )
}

export function saveSyncPhase(
  row: Omit<DbSyncPhase, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): void {
  const definition =
    row.definition_json ?? JSON.stringify(parsePhaseDefinition("{}", row.id, row.label))
  getDb()
    .prepare(
      `INSERT INTO sync_phases (tenant_id, id, label, sort_order, built_in, definition_json)
       VALUES (@tenant_id, @id, @label, @sort_order, @built_in, @definition_json)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         sort_order = excluded.sort_order,
         definition_json = excluded.definition_json`
    )
    .run({ ...row, built_in: row.built_in ?? 0, definition_json: definition })
}

export function saveSyncAction(
  row: Omit<DbSyncAction, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): void {
  const definition =
    row.definition_json ?? JSON.stringify(parseKindDefinition("{}", row.id, row.label))
  getDb()
    .prepare(
      `INSERT INTO sync_actions (tenant_id, id, label, built_in, definition_json)
       VALUES (@tenant_id, @id, @label, @built_in, @definition_json)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         definition_json = excluded.definition_json`
    )
    .run({ ...row, built_in: row.built_in ?? 0, definition_json: definition })
}

export function saveSyncFlow(row: DbSyncFlow): void {
  getDb()
    .prepare(
      `INSERT INTO sync_flows (tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by)
       VALUES (@tenant_id, @id, @label, @description, @steps_json, @built_in, @updated_at, @updated_by)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         description = excluded.description,
         steps_json = excluded.steps_json,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
    .run(row)
}

export function deleteSyncPhase(tenantId: string, id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM sync_phases WHERE tenant_id = ? AND id = ? AND built_in = 0")
    .run(tenantId, id)
  return result.changes > 0
}

export function deleteSyncAction(tenantId: string, id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM sync_actions WHERE tenant_id = ? AND id = ? AND built_in = 0")
    .run(tenantId, id)
  return result.changes > 0
}

export function deleteSyncFlow(tenantId: string, id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM sync_flows WHERE tenant_id = ? AND id = ? AND built_in = 0")
    .run(tenantId, id)
  return result.changes > 0
}

export function syncCatalogEmpty(tenantId = DEFAULT_TENANT): boolean {
  const row = getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM sync_phases WHERE tenant_id = ?) +
        (SELECT COUNT(*) FROM sync_actions WHERE tenant_id = ?) +
        (SELECT COUNT(*) FROM sync_value_sources WHERE tenant_id = ?) +
        (SELECT COUNT(*) FROM sync_flows WHERE tenant_id = ?) AS n`
    )
    .get(tenantId, tenantId, tenantId, tenantId) as { n: number }
  return row.n === 0
}

export function parseFlowSteps(json: string): AuthoredSyncFlowStep[] {
  return parseStoredFlowStepsJson(json)
}

function flowCatalogFromSyncMetadataArtifact(
  metadata: ReturnType<typeof loadSyncMetadataArtifact>,
) {
  return buildFlowCatalogFromSyncMetadataDoc({
    phases: metadata.phases,
    actions: metadata.actions,
    valueSources: metadata.valueSources,
  })
}

function serializeFlowStepsFromArtifact(
  metadata: ReturnType<typeof loadSyncMetadataArtifact>,
  steps: AuthoredSyncFlowStep[],
): string {
  return JSON.stringify(prepareFlowStepsForStorage(steps, flowCatalogFromSyncMetadataArtifact(metadata)))
}

/** @internal Used when seeding built-in flows from an already-loaded artifact document. */
export function serializeBuiltInFlowStepsFromArtifact(
  metadata: ReturnType<typeof loadSyncMetadataArtifact>,
  steps: AuthoredSyncFlowStep[],
): string {
  return serializeFlowStepsFromArtifact(metadata, steps)
}

/** Upsert built-in flows from deploy/sync/artifacts/sync-metadata.json (canonical camelCase). */
export function syncBuiltInFlowsFromArtifact(
  projectRoot: string,
  tenantId = DEFAULT_TENANT,
): void {
  const metadata = loadSyncMetadataArtifact(resolve(projectRoot))
  const now = new Date().toISOString()
  const stmt = getDb().prepare(
    `INSERT INTO sync_flows (tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
     ON CONFLICT(tenant_id, id) DO UPDATE SET
       label = excluded.label,
       description = excluded.description,
       steps_json = CASE WHEN sync_flows.built_in = 1 THEN excluded.steps_json ELSE sync_flows.steps_json END,
       updated_at = excluded.updated_at,
       updated_by = NULL`,
  )

  for (const [id, flow] of Object.entries(metadata.flows)) {
    stmt.run(
      tenantId,
      id,
      flow.label,
      flow.description ?? "",
      serializeFlowStepsFromArtifact(metadata, flow.steps),
      now,
    )
  }
}

export function mapPhaseDefinition(row: Pick<DbSyncPhase, "id" | "label" | "definition_json">) {
  return parsePhaseDefinition(row.definition_json, row.id, row.label)
}

export function mapKindDefinition(row: Pick<DbSyncAction, "id" | "label" | "definition_json">) {
  return parseKindDefinition(row.definition_json, row.id, row.label)
}

/** Sync deploy-seeded built-in rows from deploy/sync/artifacts/sync-metadata.json. */
export function syncDeploySyncMetadataFromArtifact(projectRoot: string, tenantId = DEFAULT_TENANT): void {
  const metadata = loadSyncMetadataArtifact(resolve(projectRoot))

  for (const phase of metadata.phases) {
    getDb()
      .prepare(
        `INSERT INTO sync_phases (tenant_id, id, label, sort_order, built_in, definition_json)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET
           label = excluded.label,
           sort_order = excluded.sort_order,
           definition_json = CASE WHEN sync_phases.built_in = 1 THEN excluded.definition_json ELSE sync_phases.definition_json END`
      )
      .run(tenantId, phase.id, phase.label, phase.sortOrder, JSON.stringify(phase.definition))
  }

  for (const action of metadata.actions) {
    getDb()
      .prepare(
        `INSERT INTO sync_actions (tenant_id, id, label, built_in, definition_json)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET
           label = excluded.label,
           definition_json = CASE WHEN sync_actions.built_in = 1 THEN excluded.definition_json ELSE sync_actions.definition_json END`
      )
      .run(tenantId, action.id, action.label, JSON.stringify(action.definition))
  }

  for (const valueSource of metadata.valueSources ?? []) {
    getDb()
      .prepare(
        `INSERT INTO sync_value_sources (tenant_id, id, label, built_in, definition_json)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET
           label = excluded.label,
           definition_json = CASE WHEN sync_value_sources.built_in = 1 THEN excluded.definition_json ELSE sync_value_sources.definition_json END`
      )
      .run(
        tenantId,
        valueSource.id,
        valueSource.label,
        JSON.stringify(valueSource.definition),
      )
  }

  for (const row of listSyncPhases(tenantId)) {
    if (row.definition_json && row.definition_json !== "{}") continue
    saveSyncPhase({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      sort_order: row.sort_order,
      built_in: row.built_in,
    })
  }

  for (const row of listSyncActions(tenantId)) {
    if (row.definition_json && row.definition_json !== "{}") continue
    saveSyncAction({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      built_in: row.built_in,
    })
  }

  syncBuiltInFlowsFromArtifact(projectRoot, tenantId)
}

/** @deprecated Use syncDeploySyncMetadataFromArtifact */
export function syncDeployRunCatalogFromArtifact(projectRoot: string, tenantId = DEFAULT_TENANT): void {
  syncDeploySyncMetadataFromArtifact(projectRoot, tenantId)
}

/** @deprecated Use syncDeploySyncMetadataFromArtifact */
export function backfillSyncRunCatalogDefinitions(tenantId = DEFAULT_TENANT): void {
  void tenantId
}
