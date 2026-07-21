/**
 * UI helpers for resolving connector writeEnabled against sync envs / tool args.
 * Pure decisions live in @mia/shared-types; this only binds wire DTOs.
 */

import {
  connectorWriteEnabled,
  conflictForApprovalVsConnector,
  conflictForEnvAccessVsConnector,
  conflictForPolicyRuleVsConnector,
  type ConnectorWriteConflict,
} from "@mia/shared-types"
import type { ConnectorAdmin, SyncEnvironmentAdmin } from "../types"

export function writeEnabledForConnectorId(
  connectors: readonly ConnectorAdmin[],
  connectorId: string | null | undefined,
): boolean | null {
  if (!connectorId) return null
  const conn = connectors.find((c) => c.id === connectorId)
  if (!conn) return null
  return connectorWriteEnabled(conn.config as Record<string, unknown>)
}

export function findEnvByName(
  envs: readonly SyncEnvironmentAdmin[],
  name: string | null | undefined,
): SyncEnvironmentAdmin | undefined {
  if (!name) return undefined
  const key = name.toLowerCase()
  return envs.find((e) => e.name.toLowerCase() === key)
}

/** Resolve writeEnabled for a sync env name via its linked connector. */
export function writeEnabledForEnvName(
  envs: readonly SyncEnvironmentAdmin[],
  connectors: readonly ConnectorAdmin[],
  envName: string | null | undefined,
): {
  writeEnabled: boolean | null
  connectorId: string | null
  env: SyncEnvironmentAdmin | undefined
} {
  const env = findEnvByName(envs, envName)
  if (!env) return { writeEnabled: null, connectorId: null, env: undefined }
  return {
    writeEnabled: writeEnabledForConnectorId(connectors, env.connectorId),
    connectorId: env.connectorId ?? null,
    env,
  }
}

export function conflictForSyncEnvironment(
  env: Pick<SyncEnvironmentAdmin, "name" | "connectorId" | "allowedOperations">,
  connectors: readonly ConnectorAdmin[],
): ConnectorWriteConflict | null {
  return conflictForEnvAccessVsConnector({
    envName: env.name,
    connectorId: env.connectorId,
    allowedOperations: env.allowedOperations,
    connectorWriteEnabled: writeEnabledForConnectorId(connectors, env.connectorId),
  })
}

export function conflictsForPolicyRules(input: {
  rules: ReadonlyArray<{
    name: string
    effect: string
    condition: string
    parameters: Record<string, unknown>
  }>
  envs: readonly SyncEnvironmentAdmin[]
  connectors: readonly ConnectorAdmin[]
}): ConnectorWriteConflict[] {
  const out: ConnectorWriteConflict[] = []
  const seen = new Set<string>()
  for (const rule of input.rules) {
    if (rule.condition !== "selectors") continue
    const selectors = (rule.parameters["selectors"] ?? {}) as Record<string, unknown>
    const dbOperation = typeof selectors["dbOperation"] === "string" ? selectors["dbOperation"] : null
    const dbEnvironment =
      typeof selectors["dbEnvironment"] === "string" ? selectors["dbEnvironment"] : null
    const envs = dbEnvironment
      ? input.envs.filter((e) => e.name.toLowerCase() === dbEnvironment.toLowerCase())
      : input.envs
    for (const env of envs) {
      const conflict = conflictForPolicyRuleVsConnector({
        policyName: rule.name,
        effect: rule.effect,
        dbOperation,
        dbEnvironment,
        envName: env.name,
        connectorId: env.connectorId,
        connectorWriteEnabled: writeEnabledForConnectorId(input.connectors, env.connectorId),
      })
      if (!conflict) continue
      const key = `${conflict.policyName ?? ""}:${conflict.envName ?? ""}:${conflict.connectorId ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(conflict)
    }
  }
  return out
}

/** Best-effort env name from tool args (sync target or MSSQL connection). */
export function envNameFromToolArgs(
  toolName: string,
  args?: Record<string, unknown> | null,
): string | null {
  if (!args) return null
  if (toolName === "sync_execute" || toolName.endsWith("_sync_execute")) {
    const target = args["target"]
    if (typeof target === "string" && target.trim()) return target.trim()
  }
  const connection = args["connection"]
  if (typeof connection === "string" && connection.trim()) return connection.trim()
  return null
}

export function conflictForPendingApproval(input: {
  toolName: string
  args?: Record<string, unknown> | null
  envs: readonly SyncEnvironmentAdmin[]
  connectors: readonly ConnectorAdmin[]
}): ConnectorWriteConflict | null {
  const envName = envNameFromToolArgs(input.toolName, input.args)
  const resolved = writeEnabledForEnvName(input.envs, input.connectors, envName)
  return conflictForApprovalVsConnector({
    toolName: input.toolName,
    args: input.args,
    connectorWriteEnabled: resolved.writeEnabled,
    connectorId: resolved.connectorId,
    envName: resolved.env?.name ?? envName,
  })
}
