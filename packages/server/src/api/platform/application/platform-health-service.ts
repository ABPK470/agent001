import { buildCatalog, getMssqlConfig, type AgentHost } from "@mia/agent"
import { validateEntityDefinition } from "@mia/sync"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"

import {
  findExistingCatalogCachePath,
  resolveCatalogCachePath,
} from "../../../infra/catalog/catalog-cache-path.js"

import {
  ensureSyncDefinitionConfigs,
  seedEntityRegistryIfEmpty,
} from "../../sync/index.js"
import * as db from "../../../infra/persistence/sqlite.js"
import { getDb } from "../../../infra/persistence/connection.js"

const PUBLISHED_BUNDLE_PATH = "sync-definitions/published/definitions.bundle.json"

export interface PlatformHealth {
  ready: boolean
  hints: string[]
  mssql: { configured: boolean; connections: string[]; summary: string }
  catalog: { available: boolean; detail: string | null }
  entities: { count: number; valid: boolean; errors: string[] }
  publish: {
    ready: boolean
    publishedAt: string | null
    publishedVersion: string | null
    definitionCount: number
  }
}

function readCatalogCacheDetail(path: string): string {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      builtAt?: string
      stats?: Record<string, number>
    }
    const stats = raw.stats
    return stats ? `${stats.tables ?? 0} tables · ${stats.fks ?? 0} FKs` : (raw.builtAt ?? "cached")
  } catch {
    return "cached"
  }
}

function mssqlConnectionNames(host: AgentHost): string[] {
  // Live: prefer the connector-keyed pool provider (reads the connectors DB on
  // every call) so runtime enable/disable is reflected without a restart.
  const pools = host.mssql.pools
  if (pools) return pools.list().map((c) => c.name)
  return getMssqlConfig(host).map((c) => c.name)
}

export function getPlatformHealth(
  projectRoot: string,
  mssqlSummary: string,
  bootHost: AgentHost,
): PlatformHealth {
  const pools = bootHost.mssql.pools
  const configured = pools ? pools.list().length > 0 : mssqlSummary !== "not configured"
  const connections = configured ? mssqlConnectionNames(bootHost) : []

  let catalogAvailable = false
  let catalogDetail: string | null = null
  if (configured && connections.length > 0) {
    const path = findExistingCatalogCachePath(connections)
    if (path) {
      catalogAvailable = true
      catalogDetail = readCatalogCacheDetail(path)
    }
  }

  const entities = db.listEntityDefinitions("_default")
  const entityErrors: string[] = []
  for (const entity of entities) {
    const validation = validateEntityDefinition(entity)
    if (!validation.ok) {
      entityErrors.push(`${entity.id}: ${validation.errors[0]?.message ?? "invalid"}`)
    }
  }

  let publishedAt: string | null = null
  let publishedVersion: string | null = null
  let definitionCount = 0
  const bundlePath = resolve(projectRoot, PUBLISHED_BUNDLE_PATH)
  if (existsSync(bundlePath)) {
    try {
      const bundle = JSON.parse(readFileSync(bundlePath, "utf-8")) as {
        publishedAt?: string
        publishedVersion?: string
        definitions?: Record<string, unknown | null>
      }
      publishedAt = bundle.publishedAt ?? null
      publishedVersion = bundle.publishedVersion ?? null
      definitionCount = Object.values(bundle.definitions ?? {}).filter((d) => d != null).length
    } catch {
      /* ignore corrupt bundle */
    }
  }

  const hints: string[] = []
  if (!configured) {
    hints.push(
      "Optional: add a SQL Server connector (Connectors, in the platform menu) and restart for live schema catalog and sync against SQL Server.",
    )
  } else if (!catalogAvailable) {
    hints.push(
      "MSSQL schema catalog cache is missing — use Policies → Platform → Rebuild schema catalog (requires a reachable database), or restart the server after MSSQL is up.",
    )
  }
  if (entities.length === 0) {
    hints.push(
      "No entity definitions yet — use Policies → Platform → Use shipped artifacts, or Refresh from database when MSSQL is configured.",
    )
  } else if (entityErrors.length > 0) {
    hints.push(`Fix ${entityErrors.length} entity validation issue(s) in Entity Registry.`)
  }
  if (!publishedAt || definitionCount === 0) {
    hints.push("Publish sync definitions from Entity Registry (⚙ → Publish) before running sync.")
  }

  const ready =
    entities.length > 0 &&
    entityErrors.length === 0 &&
    publishedAt != null &&
    definitionCount > 0 &&
    (!configured || catalogAvailable)

  return {
    ready,
    hints,
    mssql: { configured, connections, summary: mssqlSummary },
    catalog: { available: catalogAvailable, detail: catalogDetail },
    entities: {
      count: entities.length,
      valid: entityErrors.length === 0,
      errors: entityErrors.slice(0, 12),
    },
    publish: {
      ready: publishedAt != null && definitionCount > 0,
      publishedAt,
      publishedVersion,
      definitionCount,
    },
  }
}

export async function rebuildPlatformCatalog(
  host: AgentHost,
): Promise<{ ok: boolean; message: string }> {
  const configs = getMssqlConfig(host)
  if (configs.length === 0) {
    return {
      ok: false,
      message: "MSSQL is not configured — add a SQL Server connector (Connectors, in the platform menu) and restart the server.",
    }
  }

  const conns = configs.map((c) => c.name)
  const lines: string[] = []

  for (const conn of conns) {
    const cachePath = resolveCatalogCachePath(conn, conns)
    try {
      const catalog = await buildCatalog(host, {
        connection: conn,
        cachePath,
        maxAgeMs: 0,
      })
      const stats = catalog.stats()
      lines.push(`${conn}: ${stats.tables} tables, ${stats.fks} FKs`)
    } catch (error) {
      return {
        ok: false,
        message: `Catalog build failed for "${conn}": ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  return { ok: true, message: lines.join(" · ") }
}

/** Wipe entity registry + published bundle, then re-seed entities from deploy artifacts. */
export function factoryResetSyncPlatform(projectRoot: string): { seeded: number; entityIds: string[] } {
  const database = getDb()
  db.wipeEntityRegistry()
  database.exec(`DELETE FROM sync_definition_configs`)

  const bundlePath = resolve(projectRoot, PUBLISHED_BUNDLE_PATH)
  if (existsSync(bundlePath)) {
    try {
      unlinkSync(bundlePath)
    } catch {
      /* ignore */
    }
  }

  const seed = seedEntityRegistryIfEmpty(projectRoot)
  if (seed.seeded > 0) {
    ensureSyncDefinitionConfigs(projectRoot)
  }
  return { seeded: seed.seeded, entityIds: seed.entityIds }
}
