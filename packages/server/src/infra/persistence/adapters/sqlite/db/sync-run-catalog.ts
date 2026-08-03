import type { AuthoredSyncFlowStep } from "@mia/shared-types"
import { loadSyncMetadataArtifact, parseKindDefinition, parsePhaseDefinition } from "@mia/sync"
import { sql } from "kysely"
import { resolve } from "node:path"

import {
  buildFlowCatalogFromSyncMetadataDoc,
  parseStoredFlowStepsJson,
  prepareFlowStepsForStorage,
} from "../../../sync-flow-steps.js"
import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runChangesAsync, runGetAsync } from "../../../schema/execute-async.js"
import { getRowByKeysAsync, upsertRowAsync } from "../../../schema/upsert.js"

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

export async function listSyncPhases(tenantId = DEFAULT_TENANT): Promise<DbSyncPhase[]> {
  const compiled = getPlatformDb()
    .selectFrom("sync_phases")
    .select(["tenant_id", "id", "label", "sort_order", "built_in", "definition_json"])
    .where("tenant_id", "=", tenantId)
    .orderBy("sort_order")
    .orderBy("id")
    .compile()
  return await runAllAsync<DbSyncPhase>(compiled)
}

export async function listSyncActions(tenantId = DEFAULT_TENANT): Promise<DbSyncAction[]> {
  const compiled = getPlatformDb()
    .selectFrom("sync_actions")
    .select(["tenant_id", "id", "label", "built_in", "definition_json"])
    .where("tenant_id", "=", tenantId)
    .orderBy("id")
    .compile()
  return await runAllAsync<DbSyncAction>(compiled)
}

export async function listSyncFlows(tenantId = DEFAULT_TENANT): Promise<DbSyncFlow[]> {
  const compiled = getPlatformDb()
    .selectFrom("sync_flows")
    .select([
      "tenant_id",
      "id",
      "label",
      "description",
      "steps_json",
      "built_in",
      "updated_at",
      "updated_by",
    ])
    .where("tenant_id", "=", tenantId)
    .orderBy("built_in", "desc")
    .orderBy("id")
    .compile()
  return await runAllAsync<DbSyncFlow>(compiled)
}

export async function getSyncFlow(tenantId: string, id: string): Promise<DbSyncFlow | null> {
  const compiled = getPlatformDb()
    .selectFrom("sync_flows")
    .select([
      "tenant_id",
      "id",
      "label",
      "description",
      "steps_json",
      "built_in",
      "updated_at",
      "updated_by",
    ])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .compile()
  return await runGetAsync<DbSyncFlow>(compiled) ?? null
}

export async function saveSyncPhase(
  row: Omit<DbSyncPhase, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): Promise<void> {
  const definition =
    row.definition_json ?? JSON.stringify(parsePhaseDefinition("{}", row.id, row.label))
  const builtIn = row.built_in ?? 0
  await upsertRowAsync({
    table: "sync_phases",
    keys: { tenant_id: row.tenant_id, id: row.id },
    insert: {
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      sort_order: row.sort_order,
      built_in: builtIn,
      definition_json: definition,
    },
    update: {
      label: row.label,
      sort_order: row.sort_order,
      definition_json: definition,
    },
  })
}

export async function saveSyncAction(
  row: Omit<DbSyncAction, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): Promise<void> {
  const definition =
    row.definition_json ?? JSON.stringify(parseKindDefinition("{}", row.id, row.label))
  const builtIn = row.built_in ?? 0
  await upsertRowAsync({
    table: "sync_actions",
    keys: { tenant_id: row.tenant_id, id: row.id },
    insert: {
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      built_in: builtIn,
      definition_json: definition,
    },
    update: {
      label: row.label,
      definition_json: definition,
    },
  })
}

export async function saveSyncFlow(row: DbSyncFlow): Promise<void> {
  await upsertRowAsync({
    table: "sync_flows",
    keys: { tenant_id: row.tenant_id, id: row.id },
    insert: row,
    update: {
      label: row.label,
      description: row.description,
      steps_json: row.steps_json,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    },
  })
}

export async function deleteSyncPhase(tenantId: string, id: string): Promise<boolean> {
  const compiled = getPlatformDb()
    .deleteFrom("sync_phases")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("built_in", "=", 0)
    .compile()
  return await runChangesAsync(compiled) > 0
}

export async function deleteSyncAction(tenantId: string, id: string): Promise<boolean> {
  const compiled = getPlatformDb()
    .deleteFrom("sync_actions")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("built_in", "=", 0)
    .compile()
  return await runChangesAsync(compiled) > 0
}

export async function deleteSyncFlow(tenantId: string, id: string): Promise<boolean> {
  const compiled = getPlatformDb()
    .deleteFrom("sync_flows")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("built_in", "=", 0)
    .compile()
  return await runChangesAsync(compiled) > 0
}

export async function syncCatalogEmpty(tenantId = DEFAULT_TENANT): Promise<boolean> {
  const compiled = getPlatformDb()
    .selectNoFrom(
      sql<number>`(
        (SELECT COUNT(*) FROM sync_phases WHERE tenant_id = ${tenantId}) +
        (SELECT COUNT(*) FROM sync_actions WHERE tenant_id = ${tenantId}) +
        (SELECT COUNT(*) FROM sync_value_sources WHERE tenant_id = ${tenantId}) +
        (SELECT COUNT(*) FROM sync_flows WHERE tenant_id = ${tenantId})
      )`.as("n"),
    )
    .compile()
  const row = await runGetAsync<{ n: number }>(compiled)
  return (row?.n ?? 0) === 0
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

/**
 * Upsert built-in flows from deploy/sync/artifacts/sync-metadata.json.
 *
 * Tip SoT: valid existing steps survive boot/seed refresh (operator edits stick).
 * Corrupt tip (e.g. legacy kebab-case) is repaired from the artifact.
 * New built-in ids are inserted from the artifact.
 */
export async function syncBuiltInFlowsFromArtifact(
  projectRoot: string,
  tenantId = DEFAULT_TENANT,
): Promise<void> {
  const metadata = loadSyncMetadataArtifact(resolve(projectRoot))
  const now = new Date().toISOString()

  for (const [id, flow] of Object.entries(metadata.flows)) {
    const artifactStepsJson = serializeFlowStepsFromArtifact(metadata, flow.steps)
    const existing = await getSyncFlow(tenantId, id)
    let stepsJson = artifactStepsJson
    let updatedAt = now
    let updatedBy: string | null = null

    if (existing) {
      try {
        parseFlowSteps(existing.steps_json)
        // Valid tip — keep operator/authored steps; refresh label/description only.
        stepsJson = existing.steps_json
        updatedAt = existing.updated_at
        updatedBy = existing.updated_by
      } catch {
        // Corrupt tip — repair from artifact.
        stepsJson = artifactStepsJson
        updatedAt = now
        updatedBy = null
      }
    }

    await upsertRowAsync({
      table: "sync_flows",
      keys: { tenant_id: tenantId, id },
      insert: {
        tenant_id: tenantId,
        id,
        label: flow.label,
        description: flow.description ?? "",
        steps_json: stepsJson,
        built_in: 1,
        updated_at: updatedAt,
        updated_by: updatedBy,
      },
      update: {
        label: flow.label,
        description: flow.description ?? "",
        steps_json: stepsJson,
        updated_at: updatedAt,
        updated_by: updatedBy,
      },
    })
  }
}

export function mapPhaseDefinition(row: Pick<DbSyncPhase, "id" | "label" | "definition_json">) {
  return parsePhaseDefinition(row.definition_json, row.id, row.label)
}

export function mapKindDefinition(row: Pick<DbSyncAction, "id" | "label" | "definition_json">) {
  return parseKindDefinition(row.definition_json, row.id, row.label)
}

/** Sync deploy-seeded built-in rows from deploy/sync/artifacts/sync-metadata.json. */
export async function syncDeploySyncMetadataFromArtifact(projectRoot: string, tenantId = DEFAULT_TENANT): Promise<void> {
  const metadata = loadSyncMetadataArtifact(resolve(projectRoot))

  for (const phase of metadata.phases) {
    const definitionJson = JSON.stringify(phase.definition)
    const existing = await getRowByKeysAsync<{ built_in: number; definition_json: string }>("sync_phases", {
      tenant_id: tenantId,
      id: phase.id,
    })
    await upsertRowAsync({
      table: "sync_phases",
      keys: { tenant_id: tenantId, id: phase.id },
      insert: {
        tenant_id: tenantId,
        id: phase.id,
        label: phase.label,
        sort_order: phase.sortOrder,
        built_in: 1,
        definition_json: definitionJson,
      },
      update: {
        label: phase.label,
        sort_order: phase.sortOrder,
        definition_json:
          existing && existing.built_in !== 1 ? existing.definition_json : definitionJson,
      },
    })
  }

  for (const action of metadata.actions) {
    const definitionJson = JSON.stringify(action.definition)
    const existing = await getRowByKeysAsync<{ built_in: number; definition_json: string }>("sync_actions", {
      tenant_id: tenantId,
      id: action.id,
    })
    await upsertRowAsync({
      table: "sync_actions",
      keys: { tenant_id: tenantId, id: action.id },
      insert: {
        tenant_id: tenantId,
        id: action.id,
        label: action.label,
        built_in: 1,
        definition_json: definitionJson,
      },
      update: {
        label: action.label,
        definition_json:
          existing && existing.built_in !== 1 ? existing.definition_json : definitionJson,
      },
    })
  }

  for (const valueSource of metadata.valueSources ?? []) {
    const definitionJson = JSON.stringify(valueSource.definition)
    const existing = await getRowByKeysAsync<{ built_in: number; definition_json: string }>(
      "sync_value_sources",
      { tenant_id: tenantId, id: valueSource.id },
    )
    await upsertRowAsync({
      table: "sync_value_sources",
      keys: { tenant_id: tenantId, id: valueSource.id },
      insert: {
        tenant_id: tenantId,
        id: valueSource.id,
        label: valueSource.label,
        built_in: 1,
        definition_json: definitionJson,
      },
      update: {
        label: valueSource.label,
        definition_json:
          existing && existing.built_in !== 1 ? existing.definition_json : definitionJson,
      },
    })
  }

  for (const row of await listSyncPhases(tenantId)) {
    if (row.definition_json && row.definition_json !== "{}") continue
    await saveSyncPhase({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      sort_order: row.sort_order,
      built_in: row.built_in,
    })
  }

  for (const row of await listSyncActions(tenantId)) {
    if (row.definition_json && row.definition_json !== "{}") continue
    await saveSyncAction({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      built_in: row.built_in,
    })
  }

  await syncBuiltInFlowsFromArtifact(projectRoot, tenantId)
}

/** @deprecated Use syncDeploySyncMetadataFromArtifact */
export async function syncDeployRunCatalogFromArtifact(projectRoot: string, tenantId = DEFAULT_TENANT): Promise<void> {
  await syncDeploySyncMetadataFromArtifact(projectRoot, tenantId)
}

/** @deprecated Use syncDeploySyncMetadataFromArtifact */
export function backfillSyncRunCatalogDefinitions(tenantId = DEFAULT_TENANT): void {
  void tenantId
}
