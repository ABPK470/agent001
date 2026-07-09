import { getMssqlConfig, type AgentHost } from "@mia/agent"
import { resolve } from "node:path"

import { ensureSyncDefinitionConfigs } from "../../sync/application/definitions.js"
import {
  ensureDeploySyncMetadataSeeds,
  refreshBuiltInFlowPresetsFromArtifact,
} from "../../sync/application/seed-sync-metadata.js"
import { factoryResetSyncPlatform, rebuildPlatformCatalog } from "./platform-health-service.js"

export interface ArtifactRefreshResult {
  ok: boolean
  message: string
  source: "shipped" | "mssql"
  connection?: string
  entities?: string[]
  stepTypes?: number
  flows?: number
  activitySpecs?: number
  reseeded?: { seeded: number; entityIds: string[] }
}

/** Import deploy/sync artifacts from disk into SQLite (entity registry + sync catalog). */
export function importDeployArtifactsIntoSqlite(
  projectRoot: string,
  options: { reseedEntities: boolean },
): { seeded: number; entityIds: string[] } {
  let seeded = 0
  let entityIds: string[] = []

  if (options.reseedEntities) {
    const reset = factoryResetSyncPlatform(projectRoot)
    seeded = reset.seeded
    entityIds = reset.entityIds
    if (seeded > 0) {
      ensureSyncDefinitionConfigs(projectRoot)
    }
  }

  ensureDeploySyncMetadataSeeds(projectRoot)
  refreshBuiltInFlowPresetsFromArtifact(projectRoot)

  return { seeded, entityIds }
}

/** Use bundled deploy/sync artifacts — re-seed SQLite from disk. */
export function useShippedDeployArtifacts(projectRoot: string): ArtifactRefreshResult {
  const reseeded = importDeployArtifactsIntoSqlite(projectRoot, { reseedEntities: true })
  const message =
    reseeded.seeded > 0
      ? `Loaded ${reseeded.seeded} entity definition(s) from shipped artifacts. Publish from Entity Registry when ready.`
      : "Sync catalog refreshed from shipped artifacts. Entity registry was not empty — entities unchanged."

  return {
    ok: true,
    message,
    source: "shipped",
    entities: reseeded.entityIds,
    reseeded,
  }
}

/** Regenerate deploy/sync artifacts from live MSSQL, then optionally import into SQLite. */
export async function refreshDeployArtifactsFromDatabase(
  projectRoot: string,
  host: AgentHost,
  options: { connection?: string; reseedSqlite?: boolean } = {},
): Promise<ArtifactRefreshResult> {
  const configs = getMssqlConfig(host)
  if (configs.length === 0) {
    return {
      ok: false,
      message: "MSSQL is not configured — set MSSQL_HOST or MSSQL_DATABASES in .env and restart the server.",
      source: "mssql",
    }
  }

  const connection = options.connection ?? configs[0]!.name
  const helperPath = resolve(projectRoot, "deploy/sync/helpers/refresh-from-legacy.mjs")
  const { refreshDeployArtifactsFromLegacy } = (await import(helperPath)) as {
    refreshDeployArtifactsFromLegacy: (
      root: string,
      opts: { connection?: string; force?: boolean },
    ) => Promise<{
      entities: string[]
      stepTypes: number
      flows: number
      activitySpecs: number
    }>
  }

  const generated = await refreshDeployArtifactsFromLegacy(projectRoot, {
    connection,
    force: true,
  })

  const catalog = await rebuildPlatformCatalog(projectRoot, host)
  const catalogNote = catalog.ok ? ` Schema catalog: ${catalog.message}.` : ` Schema catalog: ${catalog.message}`

  let reseeded: { seeded: number; entityIds: string[] } | undefined
  if (options.reseedSqlite !== false) {
    reseeded = importDeployArtifactsIntoSqlite(projectRoot, { reseedEntities: true })
  } else {
    ensureDeploySyncMetadataSeeds(projectRoot)
    refreshBuiltInFlowPresetsFromArtifact(projectRoot)
  }

  return {
    ok: true,
    message: `Refreshed artifacts from MSSQL (${connection}): ${generated.entities.length} entities, ${generated.stepTypes} step types, ${generated.flows} flows.${catalogNote} ${
      reseeded?.seeded
        ? `Imported ${reseeded.seeded} entities into SQLite.`
        : "SQLite entity registry unchanged."
    } Publish from Entity Registry when ready.`,
    source: "mssql",
    connection,
    entities: generated.entities,
    stepTypes: generated.stepTypes,
    flows: generated.flows,
    activitySpecs: generated.activitySpecs,
    reseeded,
  }
}
