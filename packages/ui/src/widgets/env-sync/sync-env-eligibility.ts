/**
 * Sync From/To list filters — mirrors `@mia/sync` sync-env-eligibility rules
 * using the wire shape from GET /api/sync/environments (includes connectorReady).
 */

import type { SyncEnvironment } from "../../types"

export function listSyncSourceOptions(envs: readonly SyncEnvironment[]): SyncEnvironment[] {
  return envs.filter((env) => env.role !== "target" && env.connectorReady === true)
}

export function listSyncTargetOptions(
  envs: readonly SyncEnvironment[],
  sourceName: string | null,
): SyncEnvironment[] {
  const source = sourceName ? envs.find((env) => env.name === sourceName) ?? null : null
  return envs.filter((env) => {
    if (env.role === "source" || env.connectorReady !== true) return false
    if (!source) return true
    const allowed = source.allowedSyncEnvironments
    if (allowed === null) return true
    const targetKey = env.name.trim().toLowerCase()
    return allowed.some((name) => name.trim().toLowerCase() === targetKey)
  })
}
