import {
  ensureSyncDefinitionConfigs,
  ensureCustomValueSourcesSeeded,
  ensureDeploySyncMetadataSeeds,
  ensureFlowPresetsSeeded,
  loadPersistedSyncEnvironments,
  repairBundledEntityDefinitionsFromArtifacts,
  seedEntityRegistryIfEmpty,
  seedSyncMetadataIfEmpty,
} from "../api/sync/index.js"
import { ensureInitialSyncCatalogVersion } from "../api/platform/application/sync-catalog-versioning.js"

export function loadBootSyncEnvironments(projectRoot: string, connections: ReadonlyArray<{ name: string }>) {
  const entitySeed = seedEntityRegistryIfEmpty(projectRoot)
  if (entitySeed.seeded > 0) {
    const label =
      entitySeed.source === "yaml"
        ? "deploy/sync/entity-registry.seed.yaml"
        : "deploy/sync/artifacts/entities/*.json"
    console.log(
      `[entity-registry] seeded ${entitySeed.seeded} definition(s) from ${label}: ${entitySeed.entityIds.join(", ")}`,
    )
  }
  // Refresh deploy catalog (including built-in flow presets) before reading presets for publish.
  seedSyncMetadataIfEmpty(projectRoot)
  ensureFlowPresetsSeeded(projectRoot)
  ensureDeploySyncMetadataSeeds(projectRoot)
  ensureCustomValueSourcesSeeded(projectRoot)
  const repairedEntities = repairBundledEntityDefinitionsFromArtifacts(projectRoot)
  if (repairedEntities.length > 0) {
    console.log(
      `[entity-registry] repaired ${repairedEntities.length} bundled definition(s) from deploy artifacts: ${repairedEntities.join(", ")}`,
    )
  }
  ensureSyncDefinitionConfigs(projectRoot)
  const environments = loadPersistedSyncEnvironments(projectRoot, connections)
  ensureInitialSyncCatalogVersion("system")
  return environments
}
