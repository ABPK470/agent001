import { loadSyncMetadataArtifact } from "@mia/sync"
import { resolve } from "node:path"

import * as db from "../../../infra/persistence/sqlite.js"

const DEFAULT_TENANT = "_default"

async function seedFlowPresetsFromMetadata(
  metadata: ReturnType<typeof loadSyncMetadataArtifact>,
  now = new Date().toISOString(),
): Promise<void> {
  for (const [id, flow] of Object.entries(metadata.flows)) {
    await db.saveSyncFlow({
      tenant_id: DEFAULT_TENANT,
      id,
      label: flow.label,
      description: flow.description,
      steps_json: db.serializeBuiltInFlowStepsFromArtifact(metadata, flow.steps),
      built_in: 1,
      updated_at: now,
      updated_by: null,
    })
  }
}

/** Upsert built-in flow presets from deploy/sync/artifacts/sync-metadata.json. */
export async function refreshBuiltInFlowPresetsFromArtifact(projectRoot: string): Promise<void> {
  await db.syncBuiltInFlowsFromArtifact(projectRoot, DEFAULT_TENANT)
}

/** Seed built-in flows when sync_flows is empty (migrations may populate other catalog tables first). */
export async function ensureFlowPresetsSeeded(projectRoot: string): Promise<void> {
  if ((await db.listSyncFlows(DEFAULT_TENANT)).length > 0) return
  await seedFlowPresetsFromMetadata(loadSyncMetadataArtifact(resolve(projectRoot)))
}

export async function seedSyncMetadataIfEmpty(projectRoot: string): Promise<void> {
  if (await db.syncCatalogEmpty(DEFAULT_TENANT)) {
    const metadata = loadSyncMetadataArtifact(resolve(projectRoot))
    const now = new Date().toISOString()

    for (const phase of metadata.phases) {
      await db.saveSyncPhase({
        tenant_id: DEFAULT_TENANT,
        id: phase.id,
        label: phase.label,
        sort_order: phase.sortOrder,
        built_in: 1,
        definition_json: JSON.stringify(phase.definition),
      })
    }

    for (const action of metadata.actions) {
      await db.saveSyncAction({
        tenant_id: DEFAULT_TENANT,
        id: action.id,
        label: action.label,
        built_in: 1,
        definition_json: JSON.stringify(action.definition),
      })
    }

    for (const valueSource of metadata.valueSources ?? []) {
      await db.saveSyncValueSource({
        tenant_id: DEFAULT_TENANT,
        id: valueSource.id,
        label: valueSource.label,
        built_in: 1,
        definition_json: JSON.stringify(valueSource.definition),
      })
    }

    await seedFlowPresetsFromMetadata(metadata, now)
  }

  // Migrations may populate catalog slices before phases/kinds exist.
  // Always upsert deploy artifact catalog rows so publish/validate has a full catalog.
  await ensureFlowPresetsSeeded(projectRoot)
  await ensureDeploySyncMetadataSeeds(projectRoot)
  await ensureCustomValueSourcesSeeded(projectRoot)
}

/** Refresh deploy-seeded phase/step-type/flow rows from deploy/sync/artifacts/sync-metadata.json. */
export async function ensureDeploySyncMetadataSeeds(projectRoot: string): Promise<void> {
  await db.syncDeploySyncMetadataFromArtifact(projectRoot, DEFAULT_TENANT)
}

/** Seed custom value sources when the table is empty on a fresh database. */
export async function ensureCustomValueSourcesSeeded(projectRoot: string): Promise<void> {
  if ((await db.listSyncValueSources(DEFAULT_TENANT)).length > 0) return

  const metadata = loadSyncMetadataArtifact(resolve(projectRoot))
  for (const valueSource of metadata.valueSources ?? []) {
    await db.saveSyncValueSource({
      tenant_id: DEFAULT_TENANT,
      id: valueSource.id,
      label: valueSource.label,
      built_in: 1,
      definition_json: JSON.stringify(valueSource.definition),
    })
  }
}
