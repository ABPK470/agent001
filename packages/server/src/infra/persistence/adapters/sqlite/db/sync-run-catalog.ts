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
import { runAll, runChanges, runExec, runGet } from "../../../schema/execute.js"

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
  const compiled = getPlatformDb()
    .selectFrom("sync_phases")
    .select(["tenant_id", "id", "label", "sort_order", "built_in", "definition_json"])
    .where("tenant_id", "=", tenantId)
    .orderBy("sort_order")
    .orderBy("id")
    .compile()
  return runAll<DbSyncPhase>(compiled)
}

export function listSyncActions(tenantId = DEFAULT_TENANT): DbSyncAction[] {
  const compiled = getPlatformDb()
    .selectFrom("sync_actions")
    .select(["tenant_id", "id", "label", "built_in", "definition_json"])
    .where("tenant_id", "=", tenantId)
    .orderBy("id")
    .compile()
  return runAll<DbSyncAction>(compiled)
}

export function listSyncFlows(tenantId = DEFAULT_TENANT): DbSyncFlow[] {
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
  return runAll<DbSyncFlow>(compiled)
}

export function getSyncFlow(tenantId: string, id: string): DbSyncFlow | null {
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
  return runGet<DbSyncFlow>(compiled) ?? null
}

export function saveSyncPhase(
  row: Omit<DbSyncPhase, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): void {
  const definition =
    row.definition_json ?? JSON.stringify(parsePhaseDefinition("{}", row.id, row.label))
  const builtIn = row.built_in ?? 0
  const compiled = getPlatformDb()
    .insertInto("sync_phases")
    .values({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      sort_order: row.sort_order,
      built_in: builtIn,
      definition_json: definition,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "id"]).doUpdateSet({
        label: row.label,
        sort_order: row.sort_order,
        definition_json: definition,
      }),
    )
    .compile()
  runExec(compiled)
}

export function saveSyncAction(
  row: Omit<DbSyncAction, "built_in" | "definition_json"> & {
    built_in?: number
    definition_json?: string
  },
): void {
  const definition =
    row.definition_json ?? JSON.stringify(parseKindDefinition("{}", row.id, row.label))
  const builtIn = row.built_in ?? 0
  const compiled = getPlatformDb()
    .insertInto("sync_actions")
    .values({
      tenant_id: row.tenant_id,
      id: row.id,
      label: row.label,
      built_in: builtIn,
      definition_json: definition,
    })
    .onConflict((oc) =>
      oc.columns(["tenant_id", "id"]).doUpdateSet({
        label: row.label,
        definition_json: definition,
      }),
    )
    .compile()
  runExec(compiled)
}

export function saveSyncFlow(row: DbSyncFlow): void {
  const compiled = getPlatformDb()
    .insertInto("sync_flows")
    .values(row)
    .onConflict((oc) =>
      oc.columns(["tenant_id", "id"]).doUpdateSet({
        label: row.label,
        description: row.description,
        steps_json: row.steps_json,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      }),
    )
    .compile()
  runExec(compiled)
}

export function deleteSyncPhase(tenantId: string, id: string): boolean {
  const compiled = getPlatformDb()
    .deleteFrom("sync_phases")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("built_in", "=", 0)
    .compile()
  return runChanges(compiled) > 0
}

export function deleteSyncAction(tenantId: string, id: string): boolean {
  const compiled = getPlatformDb()
    .deleteFrom("sync_actions")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("built_in", "=", 0)
    .compile()
  return runChanges(compiled) > 0
}

export function deleteSyncFlow(tenantId: string, id: string): boolean {
  const compiled = getPlatformDb()
    .deleteFrom("sync_flows")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", id)
    .where("built_in", "=", 0)
    .compile()
  return runChanges(compiled) > 0
}

export function syncCatalogEmpty(tenantId = DEFAULT_TENANT): boolean {
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
  const row = runGet<{ n: number }>(compiled)
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
export function syncBuiltInFlowsFromArtifact(
  projectRoot: string,
  tenantId = DEFAULT_TENANT,
): void {
  const metadata = loadSyncMetadataArtifact(resolve(projectRoot))
  const now = new Date().toISOString()

  for (const [id, flow] of Object.entries(metadata.flows)) {
    const artifactStepsJson = serializeFlowStepsFromArtifact(metadata, flow.steps)
    const existing = getSyncFlow(tenantId, id)
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

    const compiled = getPlatformDb()
      .insertInto("sync_flows")
      .values({
        tenant_id: tenantId,
        id,
        label: flow.label,
        description: flow.description ?? "",
        steps_json: stepsJson,
        built_in: 1,
        updated_at: updatedAt,
        updated_by: updatedBy,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "id"]).doUpdateSet({
          label: flow.label,
          description: flow.description ?? "",
          steps_json: stepsJson,
          updated_at: updatedAt,
          updated_by: updatedBy,
        }),
      )
      .compile()
    runExec(compiled)
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
    const definitionJson = JSON.stringify(phase.definition)
    const compiled = getPlatformDb()
      .insertInto("sync_phases")
      .values({
        tenant_id: tenantId,
        id: phase.id,
        label: phase.label,
        sort_order: phase.sortOrder,
        built_in: 1,
        definition_json: definitionJson,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "id"]).doUpdateSet({
          label: phase.label,
          sort_order: phase.sortOrder,
          definition_json: sql`CASE WHEN sync_phases.built_in = 1 THEN excluded.definition_json ELSE sync_phases.definition_json END`,
        }),
      )
      .compile()
    runExec(compiled)
  }

  for (const action of metadata.actions) {
    const definitionJson = JSON.stringify(action.definition)
    const compiled = getPlatformDb()
      .insertInto("sync_actions")
      .values({
        tenant_id: tenantId,
        id: action.id,
        label: action.label,
        built_in: 1,
        definition_json: definitionJson,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "id"]).doUpdateSet({
          label: action.label,
          definition_json: sql`CASE WHEN sync_actions.built_in = 1 THEN excluded.definition_json ELSE sync_actions.definition_json END`,
        }),
      )
      .compile()
    runExec(compiled)
  }

  for (const valueSource of metadata.valueSources ?? []) {
    const definitionJson = JSON.stringify(valueSource.definition)
    const compiled = getPlatformDb()
      .insertInto("sync_value_sources")
      .values({
        tenant_id: tenantId,
        id: valueSource.id,
        label: valueSource.label,
        built_in: 1,
        definition_json: definitionJson,
      })
      .onConflict((oc) =>
        oc.columns(["tenant_id", "id"]).doUpdateSet({
          label: valueSource.label,
          definition_json: sql`CASE WHEN sync_value_sources.built_in = 1 THEN excluded.definition_json ELSE sync_value_sources.definition_json END`,
        }),
      )
      .compile()
    runExec(compiled)
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
