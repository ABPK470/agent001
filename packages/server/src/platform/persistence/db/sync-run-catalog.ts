import type { AuthoredSyncFlowStep } from "@mia/shared-types"
import { loadSyncMetadataArtifact, parseKindDefinition, parsePhaseDefinition } from "@mia/sync"
import { resolve } from "node:path"

import { getDb } from "../connection.js"
import { parseStoredFlowStepsJson } from "../../../features/sync/domain/flow-steps.js"

const DEFAULT_TENANT = "_default"

export interface DbSyncRunPhase {
  tenant_id: string
  id: string
  label: string
  sort_order: number
  built_in: number
  definition_json: string
}

export interface DbSyncRunKind {
  tenant_id: string
  id: string
  label: string
  built_in: number
  definition_json: string
}

export interface DbSyncRunPreset {
  tenant_id: string
  id: string
  label: string
  description: string
  steps_json: string
  built_in: number
  updated_at: string
  updated_by: string | null
}

export function listSyncRunPhases(tenantId = DEFAULT_TENANT): DbSyncRunPhase[] {
  return getDb()
    .prepare(
      "SELECT tenant_id, id, label, sort_order, built_in, definition_json FROM sync_run_phases WHERE tenant_id = ? ORDER BY sort_order, id"
    )
    .all(tenantId) as DbSyncRunPhase[]
}

export function listSyncRunKinds(tenantId = DEFAULT_TENANT): DbSyncRunKind[] {
  return getDb()
    .prepare(
      "SELECT tenant_id, id, label, built_in, definition_json FROM sync_run_kinds WHERE tenant_id = ? ORDER BY id"
    )
    .all(tenantId) as DbSyncRunKind[]
}

export function listSyncRunPresets(tenantId = DEFAULT_TENANT): DbSyncRunPreset[] {
  return getDb()
    .prepare(
      "SELECT tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by FROM sync_run_presets WHERE tenant_id = ? ORDER BY built_in DESC, id"
    )
    .all(tenantId) as DbSyncRunPreset[]
}

export function getSyncRunPreset(tenantId: string, id: string): DbSyncRunPreset | null {
  return (
    (getDb()
      .prepare(
        "SELECT tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by FROM sync_run_presets WHERE tenant_id = ? AND id = ?"
      )
      .get(tenantId, id) as DbSyncRunPreset | undefined) ?? null
  )
}

export function saveSyncRunPhase(
  row: Omit<DbSyncRunPhase, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): void {
  const definition =
    row.definition_json ?? JSON.stringify(parsePhaseDefinition("{}", row.id, row.label))
  getDb()
    .prepare(
      `INSERT INTO sync_run_phases (tenant_id, id, label, sort_order, built_in, definition_json)
       VALUES (@tenant_id, @id, @label, @sort_order, @built_in, @definition_json)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         sort_order = excluded.sort_order,
         definition_json = excluded.definition_json`
    )
    .run({ ...row, built_in: row.built_in ?? 0, definition_json: definition })
}

export function saveSyncRunKind(
  row: Omit<DbSyncRunKind, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): void {
  const definition =
    row.definition_json ?? JSON.stringify(parseKindDefinition("{}", row.id, row.label))
  getDb()
    .prepare(
      `INSERT INTO sync_run_kinds (tenant_id, id, label, built_in, definition_json)
       VALUES (@tenant_id, @id, @label, @built_in, @definition_json)
       ON CONFLICT(tenant_id, id) DO UPDATE SET
         label = excluded.label,
         definition_json = excluded.definition_json`
    )
    .run({ ...row, built_in: row.built_in ?? 0, definition_json: definition })
}

export function saveSyncRunPreset(row: DbSyncRunPreset): void {
  getDb()
    .prepare(
      `INSERT INTO sync_run_presets (tenant_id, id, label, description, steps_json, built_in, updated_at, updated_by)
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

export function deleteSyncRunPhase(tenantId: string, id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM sync_run_phases WHERE tenant_id = ? AND id = ? AND built_in = 0")
    .run(tenantId, id)
  return result.changes > 0
}

export function deleteSyncRunKind(tenantId: string, id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM sync_run_kinds WHERE tenant_id = ? AND id = ? AND built_in = 0")
    .run(tenantId, id)
  return result.changes > 0
}

export function deleteSyncRunPreset(tenantId: string, id: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM sync_run_presets WHERE tenant_id = ? AND id = ? AND built_in = 0")
    .run(tenantId, id)
  return result.changes > 0
}

export function syncRunCatalogEmpty(tenantId = DEFAULT_TENANT): boolean {
  const row = getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM sync_run_phases WHERE tenant_id = ?) +
        (SELECT COUNT(*) FROM sync_run_kinds WHERE tenant_id = ?) +
        (SELECT COUNT(*) FROM sync_run_binding_sources WHERE tenant_id = ?) +
        (SELECT COUNT(*) FROM sync_run_presets WHERE tenant_id = ?) AS n`
    )
    .get(tenantId, tenantId, tenantId, tenantId) as { n: number }
  return row.n === 0
}

export function parsePresetSteps(json: string): AuthoredSyncFlowStep[] {
  return parseStoredFlowStepsJson(json)
}

export function mapPhaseDefinition(row: Pick<DbSyncRunPhase, "id" | "label" | "definition_json">) {
  return parsePhaseDefinition(row.definition_json, row.id, row.label)
}

export function mapKindDefinition(row: Pick<DbSyncRunKind, "id" | "label" | "definition_json">) {
  return parseKindDefinition(row.definition_json, row.id, row.label)
}

/** Sync deploy-seeded built-in rows from deploy/sync/artifacts/sync-metadata.json. */
export function syncDeploySyncMetadataFromArtifact(projectRoot: string, tenantId = DEFAULT_TENANT): void {
  const metadata = loadSyncMetadataArtifact(resolve(projectRoot))

  for (const phase of metadata.phases) {
    getDb()
      .prepare(
        `INSERT INTO sync_run_phases (tenant_id, id, label, sort_order, built_in, definition_json)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET
           label = excluded.label,
           sort_order = excluded.sort_order,
           definition_json = CASE WHEN sync_run_phases.built_in = 1 THEN excluded.definition_json ELSE sync_run_phases.definition_json END`
      )
      .run(tenantId, phase.id, phase.label, phase.sortOrder, JSON.stringify(phase.definition))
  }

  for (const stepType of metadata.stepTypes) {
    getDb()
      .prepare(
        `INSERT INTO sync_run_kinds (tenant_id, id, label, built_in, definition_json)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET
           label = excluded.label,
           definition_json = CASE WHEN sync_run_kinds.built_in = 1 THEN excluded.definition_json ELSE sync_run_kinds.definition_json END`
      )
      .run(tenantId, stepType.id, stepType.label, JSON.stringify(stepType.definition))
  }

  for (const customValueSource of metadata.customValueSources ?? []) {
    getDb()
      .prepare(
        `INSERT INTO sync_run_binding_sources (tenant_id, id, label, built_in, definition_json)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(tenant_id, id) DO UPDATE SET
           label = excluded.label,
           definition_json = CASE WHEN sync_run_binding_sources.built_in = 1 THEN excluded.definition_json ELSE sync_run_binding_sources.definition_json END`
      )
      .run(
        tenantId,
        customValueSource.id,
        customValueSource.label,
        JSON.stringify(customValueSource.definition),
      )
  }

  for (const row of listSyncRunPhases(tenantId)) {
    if (row.definition_json && row.definition_json !== "{}") continue
    saveSyncRunPhase({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      sort_order: row.sort_order,
      built_in: row.built_in,
    })
  }

  for (const row of listSyncRunKinds(tenantId)) {
    if (row.definition_json && row.definition_json !== "{}") continue
    saveSyncRunKind({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      built_in: row.built_in,
    })
  }
}

/** @deprecated Use syncDeploySyncMetadataFromArtifact */
export function syncDeployRunCatalogFromArtifact(projectRoot: string, tenantId = DEFAULT_TENANT): void {
  syncDeploySyncMetadataFromArtifact(projectRoot, tenantId)
}

/** @deprecated Use syncDeploySyncMetadataFromArtifact */
export function backfillSyncRunCatalogDefinitions(tenantId = DEFAULT_TENANT): void {
  void tenantId
}
