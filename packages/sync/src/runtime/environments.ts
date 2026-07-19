/**
 * Environment registry loaders — disk + MSSQL connection bootstrap.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { getMssqlConfig } from "../adapters/mssql/connection.js"
import {
  assertNoRemovedSyncEnvironmentFields,
  replaceEnvironments,
  withPermissionDefaults,
  type LoadSyncEnvironmentsResult,
  type SyncEnvironment,
} from "../domain/environments.js"
import { EnvRole } from "../domain/enums.js"
import { normalizeServiceUrls } from "../domain/env-service-urls.js"
import type { MssqlAccessHost, SyncEnvironmentRegistryHost } from "../ports/index.js"

interface SyncEnvironmentsConfigFile {
  version: 1
  environments: Array<Partial<SyncEnvironment> & { name: string }>
}

const DEFAULT_CONFIG_PATH = "deploy/sync/sync-environments.json"

export function loadSyncEnvironments(
  projectRoot: string,
  connections: ReadonlyArray<{ name: string }>,
  relPath = DEFAULT_CONFIG_PATH
): LoadSyncEnvironmentsResult {
  const configPath = resolve(projectRoot, relPath)

  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8")
      const parsed = JSON.parse(raw) as SyncEnvironmentsConfigFile
      if (parsed.version !== 1) throw new Error(`Unsupported version: ${parsed.version}`)
      const environments = parsed.environments.map((e) => {
        assertNoRemovedSyncEnvironmentFields(
          e as Record<string, unknown>,
          `${relPath} environment "${e.name}"`,
        )
        const connectorIdRaw =
          typeof e.connectorId === "string" && e.connectorId.trim() !== "" ? e.connectorId.trim() : null
        return withPermissionDefaults({
          name: e.name,
          connectorId: connectorIdRaw,
          displayName: e.displayName ?? e.name,
          color: e.color ?? "slate",
          role: e.role ?? EnvRole.Both,
          ringOrder: typeof e.ringOrder === "number" ? e.ringOrder : 0,
          agentServiceBaseUrl: e.agentServiceBaseUrl ?? null,
          etlServiceBaseUrl: e.etlServiceBaseUrl ?? null,
          gateServiceBaseUrl: e.gateServiceBaseUrl ?? null,
          serviceUrls: normalizeServiceUrls(e.serviceUrls as Record<string, unknown> | undefined),
          allowedSyncEnvironments: Array.isArray(e.allowedSyncEnvironments)
            ? e.allowedSyncEnvironments.map(String)
            : Array.isArray((e as Record<string, unknown>).allowedSyncTargets)
              ? ((e as Record<string, unknown>).allowedSyncTargets as unknown[]).map(String)
              : null,
          defaultAccessMode: e.defaultAccessMode,
          allowedOperations: e.allowedOperations,
          denyDml: e.denyDml,
          denyDdl: e.denyDdl,
          approvalRequiredOperations: e.approvalRequiredOperations
        })
      })
      return {
        environments,
        summary: environments.map((env) => `${env.name}[${env.role}/${env.defaultAccessMode}]`).join(", "),
        source: "file"
      }
    } catch (e) {
      console.error(`Invalid ${relPath}:`, e instanceof Error ? e.message : e)
      return { environments: [], summary: "", source: "none" }
    }
  }

  const FALLBACK_PALETTE = ["blue", "teal", "indigo", "pink", "slate", "cyan"]
  const environments = connections.map((connection, i) =>
    withPermissionDefaults({
      name: connection.name,
      connectorId: connection.name,
      displayName: connection.name,
      color: FALLBACK_PALETTE[i % FALLBACK_PALETTE.length] ?? "slate",
      role: EnvRole.Both,
      ringOrder: i,
    })
  )
  return {
    environments,
    summary: environments.map((env) => `${env.name}[${env.defaultAccessMode}]`).join(", "),
    source: environments.length ? "mssql" : "none"
  }
}

/**
 * Initialise environments. Reads `deploy/sync/sync-environments.json` if
 * present; otherwise synthesises one entry per configured MSSQL connection.
 */
export async function setupEnvironments(
  host: MssqlAccessHost & SyncEnvironmentRegistryHost,
  projectRoot: string,
  relPath = DEFAULT_CONFIG_PATH
): Promise<string> {
  const loaded = loadSyncEnvironments(projectRoot, getMssqlConfig(host), relPath)
  replaceEnvironments(host, loaded.environments)
  if (loaded.source === "file") {
    console.log(`ABI environments (from ${relPath}): ${loaded.summary}`)
  } else if (loaded.source === "mssql") {
    console.log(`ABI environments (auto from MSSQL_DATABASES): ${loaded.summary}`)
  }
  return loaded.environments.map((env) => `${env.name}[${env.role}]`).join(", ")
}
