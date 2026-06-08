import { getMssqlConfig, type AgentHost } from "@mia/agent"
import {
  loadSyncEnvironments,
  replaceEnvironments,
  withPermissionDefaults,
  type SyncEnvironment
} from "@mia/sync"

import * as db from "../../platform/persistence/sqlite.js"

export interface PersistedSyncEnvironmentLoad {
  environments: SyncEnvironment[]
  source: "db" | "file" | "mssql" | "none"
  seeded: boolean
  summary: string
}

function requireProjectRoot(host: AgentHost): string {
  const root = host.sync.project.dbProjectRoot
  if (!root) {
    throw new Error("Sync orchestrator not configured — missing project root for live environment reload")
  }
  return root
}

function mergeLegacyOverrides(environments: SyncEnvironment[]): SyncEnvironment[] {
  const overrides = new Map<string, Partial<SyncEnvironment>>()
  for (const row of db.listSyncEnvOverrides()) {
    try {
      overrides.set(row.name, JSON.parse(row.overrides_json) as Partial<SyncEnvironment>)
    } catch (error) {
      console.warn(
        `[sync-envs] invalid legacy override JSON for env "${row.name}":`,
        error instanceof Error ? error.message : error
      )
    }
  }
  return environments.map((env) => {
    const override = overrides.get(env.name)
    return override ? withPermissionDefaults({ ...env, ...override, name: env.name }) : env
  })
}

function parsePersistedEnvironment(row: db.DbSyncEnvironment): SyncEnvironment {
  return withPermissionDefaults({
    ...(JSON.parse(row.body_json) as SyncEnvironment),
    name: row.name
  })
}

function renderSummary(environments: SyncEnvironment[]): string {
  return environments.map((env) => `${env.name}[${env.role}/${env.defaultAccessMode}]`).join(", ")
}

export function loadPersistedSyncEnvironments(
  projectRoot: string,
  connections: ReadonlyArray<{ name: string }>
): PersistedSyncEnvironmentLoad {
  const persistedRows = db.listSyncEnvironments()
  if (persistedRows.length > 0) {
    const environments = persistedRows.map(parsePersistedEnvironment)
    return {
      environments,
      source: "db",
      seeded: false,
      summary: renderSummary(environments)
    }
  }

  const loaded = loadSyncEnvironments(projectRoot, connections)
  const environments = mergeLegacyOverrides(loaded.environments)
  const now = new Date().toISOString()
  for (const env of environments) {
    db.saveSyncEnvironment({
      name: env.name,
      body_json: JSON.stringify(env),
      created_at: now,
      updated_at: now,
      updated_by: null
    })
  }
  return {
    environments,
    source: loaded.source,
    seeded: true,
    summary: renderSummary(environments)
  }
}

export function rebuildLiveSyncEnvironments(host: AgentHost): void {
  const loaded = loadPersistedSyncEnvironments(requireProjectRoot(host), getMssqlConfig(host))
  replaceEnvironments(host, loaded.environments)
}
