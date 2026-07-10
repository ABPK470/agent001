import type { AgentHost } from "@mia/agent"
import {
  ensureSyncDefinitionConfigs,
  ensureCustomValueSourcesSeeded,
  ensureDeploySyncMetadataSeeds,
  ensureFlowPresetsSeeded,
  loadPersistedSyncEnvironments,
  seedEntityRegistryIfEmpty,
  seedSyncMetadataIfEmpty,
} from "../features/sync/index.js"
import { syncPlanActorUpn } from "../features/sync/application/plan-actor.js"
import { ensureInitialSyncCatalogVersion } from "../features/platform/application/sync-catalog-versioning.js"
import { broadcast } from "../platform/events/broadcaster.js"
import {
  getSyncRunPlanJson,
  recordSyncRunFinish,
  recordSyncRunPreview,
  recordSyncRunStart
} from "../platform/persistence/index.js"

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
  ensureSyncDefinitionConfigs(projectRoot)
  seedSyncMetadataIfEmpty(projectRoot)
  ensureFlowPresetsSeeded(projectRoot)
  ensureDeploySyncMetadataSeeds(projectRoot)
  ensureCustomValueSourcesSeeded(projectRoot)
  const environments = loadPersistedSyncEnvironments(projectRoot, connections)
  ensureInitialSyncCatalogVersion("system")
  return environments
}

export function createSyncEventSink(): AgentHost["sync"]["events"]["sink"] {
  return (event) => {
    broadcast({ type: event.type, data: event.data })
  }
}

export function createSyncRunSink(): AgentHost["sync"]["runs"]["sink"] {
  return {
    start: (input) => {
      try {
        recordSyncRunStart(input)
      } catch (error) {
        console.warn("[sync] recordSyncRunStart failed:", error)
      }
    },
    finish: (input) => {
      try {
        recordSyncRunFinish(input)
      } catch (error) {
        console.warn("[sync] recordSyncRunFinish failed:", error)
      }
    },
    savePlan: (plan, actorUpn) => {
      try {
        const resolvedActorUpn = syncPlanActorUpn(plan) ?? actorUpn ?? null
        recordSyncRunPreview({
          planId: plan.planId,
          entityType: plan.executionContract.definitionId,
          entityId: plan.entity.id,
          entityDisplayName: plan.entity.displayName,
          source: plan.source,
          target: plan.target,
          actorUpn: resolvedActorUpn,
          previewTotals: plan.totals,
          planJson: JSON.stringify(plan)
        })
      } catch (error) {
        console.warn("[sync] recordSyncRunPreview failed:", error)
      }
    },
    loadPlan: (planId) => {
      try {
        const json = getSyncRunPlanJson(planId)
        return json ? JSON.parse(json) : null
      } catch (error) {
        console.warn("[sync] getSyncRunPlanJson failed:", error)
        return null
      }
    }
  }
}
