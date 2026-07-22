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

/**
 * After env catalog reload, keep From/To on still-valid names (or first allowed).
 * Direction policy only affects To (via the selected source’s allow-list).
 */
export function clampSyncDirectionSelection(
  envs: readonly SyncEnvironment[],
  source: string,
  target: string,
): { source: string; target: string } {
  const sources = listSyncSourceOptions(envs)
  const nextSource = sources.some((env) => env.name === source)
    ? source
    : (sources[0]?.name ?? "")
  const targets = listSyncTargetOptions(envs, nextSource || null)
  const nextTarget = targets.some((env) => env.name === target)
    ? target
    : (targets.find((env) => env.name !== nextSource)?.name ?? targets[0]?.name ?? "")
  return { source: nextSource, target: nextTarget }
}
