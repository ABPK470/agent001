import { loadSyncMetadataArtifact } from "@mia/sync"
import { resolve } from "node:path"

import * as db from "../../../infra/persistence/sqlite.js"

const DEFAULT_TENANT = "_default"

function seedFlowPresetsFromMetadata(
  metadata: ReturnType<typeof loadSyncMetadataArtifact>,
  now = new Date().toISOString(),
): void {
  for (const [id, flow] of Object.entries(metadata.flows)) {
    db.saveSyncFlow({
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
export function refreshBuiltInFlowPresetsFromArtifact(projectRoot: string): void {
  db.syncBuiltInFlowsFromArtifact(projectRoot, DEFAULT_TENANT)
}

/** Seed built-in flows when sync_flows is empty (migrations may populate other catalog tables first). */
export function ensureFlowPresetsSeeded(projectRoot: string): void {
  if (db.listSyncFlows(DEFAULT_TENANT).length > 0) return
  seedFlowPresetsFromMetadata(loadSyncMetadataArtifact(resolve(projectRoot)))
}

export function seedSyncMetadataIfEmpty(projectRoot: string): void {
  if (db.syncCatalogEmpty(DEFAULT_TENANT)) {
    const metadata = loadSyncMetadataArtifact(resolve(projectRoot))
    const now = new Date().toISOString()

    for (const phase of metadata.phases) {
      db.saveSyncPhase({
        tenant_id: DEFAULT_TENANT,
        id: phase.id,
        label: phase.label,
        sort_order: phase.sortOrder,
        built_in: 1,
        definition_json: JSON.stringify(phase.definition),
      })
    }

    for (const action of metadata.actions) {
      db.saveSyncAction({
        tenant_id: DEFAULT_TENANT,
        id: action.id,
        label: action.label,
        built_in: 1,
        definition_json: JSON.stringify(action.definition),
      })
    }

    for (const valueSource of metadata.valueSources ?? []) {
      db.saveSyncValueSource({
        tenant_id: DEFAULT_TENANT,
        id: valueSource.id,
        label: valueSource.label,
        built_in: 1,
        definition_json: JSON.stringify(valueSource.definition),
      })
    }

    seedFlowPresetsFromMetadata(metadata, now)
  }

  // Migrations may populate catalog slices before phases/kinds exist.
  // Always upsert deploy artifact catalog rows so publish/validate has a full catalog.
  ensureFlowPresetsSeeded(projectRoot)
  ensureDeploySyncMetadataSeeds(projectRoot)
  ensureCustomValueSourcesSeeded(projectRoot)
}

/** Refresh deploy-seeded phase/step-type/flow rows from deploy/sync/artifacts/sync-metadata.json. */
export function ensureDeploySyncMetadataSeeds(projectRoot: string): void {
  db.syncDeploySyncMetadataFromArtifact(projectRoot, DEFAULT_TENANT)
}

/** Seed custom value sources when the table is empty on a fresh database. */
export function ensureCustomValueSourcesSeeded(projectRoot: string): void {
  if (db.listSyncValueSources(DEFAULT_TENANT).length > 0) return

  const metadata = loadSyncMetadataArtifact(resolve(projectRoot))
  for (const valueSource of metadata.valueSources ?? []) {
    db.saveSyncValueSource({
      tenant_id: DEFAULT_TENANT,
      id: valueSource.id,
      label: valueSource.label,
      built_in: 1,
      definition_json: JSON.stringify(valueSource.definition),
    })
  }
}
