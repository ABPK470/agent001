/**
 * Sync From/To eligibility — one rule for UI lists and server preview/execute.
 *
 * An environment is Sync-selectable only when:
 *   1. `role` allows that side (source / target / both)
 *   2. `connectorId` is set and the gate says that MSSQL connector is ready
 *      (exists, kind mssql, enabled) — Bridge capabilities are irrelevant
 *   3. For a chosen source → target pair, `allowedSyncEnvironments` allows it
 *
 * Sync environments are the only From/To options. Connectors are shared plumbing.
 */

import type { MssqlAccessHost } from "../ports/host.js"
import { EnvRole } from "./enums.js"
import type { SyncEnvironment } from "./environments.js"

/** Enabled MSSQL connector ids (live). */
export type SyncConnectorReadyIds = ReadonlySet<string>

export function readyMssqlConnectorIds(host: MssqlAccessHost): SyncConnectorReadyIds {
  const pools = host.mssql.pools
  if (!pools) return new Set()
  return new Set(pools.list().map((c) => c.id))
}

export function envCanBeSyncSource(env: Pick<SyncEnvironment, "role">): boolean {
  return env.role !== EnvRole.Target
}

export function envCanBeSyncTarget(env: Pick<SyncEnvironment, "role">): boolean {
  return env.role !== EnvRole.Source
}

export function envHasReadyConnector(
  env: Pick<SyncEnvironment, "connectorId">,
  readyIds: SyncConnectorReadyIds,
): boolean {
  const id = typeof env.connectorId === "string" ? env.connectorId.trim() : ""
  return id !== "" && readyIds.has(id)
}

/** Direction policy on the source env (`null` = unrestricted, `[]` = blocked). */
export function isSyncDirectionAllowed(
  source: Pick<SyncEnvironment, "allowedSyncEnvironments" | "name">,
  target: Pick<SyncEnvironment, "name">,
): boolean {
  const allowed = source.allowedSyncEnvironments
  if (allowed === null) return true
  const targetKey = target.name.trim().toLowerCase()
  return allowed.some((name) => name.trim().toLowerCase() === targetKey)
}

export function isSyncEnvSelectableAsSource(
  env: SyncEnvironment,
  readyIds: SyncConnectorReadyIds,
): boolean {
  return envCanBeSyncSource(env) && envHasReadyConnector(env, readyIds)
}

export function isSyncEnvSelectableAsTarget(
  env: SyncEnvironment,
  readyIds: SyncConnectorReadyIds,
): boolean {
  return envCanBeSyncTarget(env) && envHasReadyConnector(env, readyIds)
}

export function listSyncSourceOptions(
  envs: readonly SyncEnvironment[],
  readyIds: SyncConnectorReadyIds,
): SyncEnvironment[] {
  return envs.filter((env) => isSyncEnvSelectableAsSource(env, readyIds))
}

/**
 * Target options for Sync From/To. When `source` is set, also applies that
 * env's outgoing direction policy.
 */
export function listSyncTargetOptions(
  envs: readonly SyncEnvironment[],
  readyIds: SyncConnectorReadyIds,
  source: SyncEnvironment | null,
): SyncEnvironment[] {
  return envs.filter((env) => {
    if (!isSyncEnvSelectableAsTarget(env, readyIds)) return false
    if (!source) return true
    return isSyncDirectionAllowed(source, env)
  })
}

export function assertEnvConnectorReady(
  env: SyncEnvironment,
  readyIds: SyncConnectorReadyIds,
): void {
  const id = typeof env.connectorId === "string" ? env.connectorId.trim() : ""
  if (!id) {
    throw new Error(
      `Environment "${env.name}" has no connectorId — link an enabled MSSQL connector in Environments.`,
    )
  }
  if (!readyIds.has(id)) {
    throw new Error(
      `Environment "${env.name}" connector "${id}" is missing, not MSSQL, or disabled. Enable it in Connectors.`,
    )
  }
}
