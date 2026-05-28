import { getMssqlConfig, type AgentHost } from "@mia/agent"
import { loadSyncEnvironments, replaceEnvironments, withPermissionDefaults, type SyncEnvironment } from "@mia/sync"

import * as db from "../../adapters/persistence/sqlite.js"

function requireProjectRoot(host: AgentHost): string {
  const root = host.sync.dbProjectRoot
  if (!root) {
    throw new Error("Sync orchestrator not configured — missing project root for live environment reload")
  }
  return root
}

export function rebuildLiveSyncEnvironments(host: AgentHost): void {
  const baseline = loadSyncEnvironments(requireProjectRoot(host), getMssqlConfig(host)).environments
  const overrides = new Map<string, Partial<SyncEnvironment>>()
  for (const row of db.listSyncEnvOverrides()) {
    try {
      overrides.set(row.name, JSON.parse(row.overrides_json) as Partial<SyncEnvironment>)
    } catch (error) {
      console.warn(`[sync-envs] invalid override JSON for env "${row.name}":`, error instanceof Error ? error.message : error)
    }
  }
  const merged = baseline.map((env) => {
    const override = overrides.get(env.name)
    return override ? withPermissionDefaults({ ...env, ...override, name: env.name }) : env
  })
  replaceEnvironments(host, merged)
}