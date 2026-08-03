import {
  ensureCustomValueSourcesSeeded,
  ensureDeploySyncMetadataSeeds,
  ensureFlowPresetsSeeded,
  loadPersistedSyncEnvironments,
  repairBundledEntityDefinitionsFromArtifacts,
  seedEntityRegistryIfEmpty,
  seedSyncMetadataIfEmpty,
} from "../api/sync/index.js"
import { ensureInitialSyncCatalogVersion } from "../api/platform/service/sync-catalog-versioning.js"

export async function loadBootSyncEnvironments(
  projectRoot: string,
  connections: ReadonlyArray<{ name: string }>,
) {
  const entitySeed = await seedEntityRegistryIfEmpty(projectRoot)
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
  await seedSyncMetadataIfEmpty(projectRoot)
  await ensureFlowPresetsSeeded(projectRoot)
  await ensureDeploySyncMetadataSeeds(projectRoot)
  await ensureCustomValueSourcesSeeded(projectRoot)
  const repairedEntities = await repairBundledEntityDefinitionsFromArtifacts(projectRoot)
  if (repairedEntities.length > 0) {
    console.log(
      `[entity-registry] repaired ${repairedEntities.length} bundled definition(s) from deploy artifacts: ${repairedEntities.join(", ")}`,
    )
  }
  const environments = await loadPersistedSyncEnvironments(projectRoot, connections)
  await ensureInitialSyncCatalogVersion("system")
  return environments
}
