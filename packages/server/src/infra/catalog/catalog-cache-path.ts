import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { resolveServerDataDir } from "../persistence/server-data-dir.js"

export { resolveServerDataDir } from "../persistence/server-data-dir.js"

/** Base catalog cache file (before per-connection suffix). */
export function resolveCatalogCacheBasePath(): string {
  const configured = process.env.CATALOG_CACHE_PATH?.trim()
  if (configured) {
    if (configured.startsWith("/")) return configured
    return resolve(resolveServerDataDir(), configured.replace(/^\.\//, ""))
  }
  return resolve(resolveServerDataDir(), "catalog-cache.json")
}

/** Per-connection catalog cache path (suffix when multiple MSSQL connections). */
export function resolveCatalogCachePath(
  connection: string,
  connections: readonly string[],
): string {
  const base = resolveCatalogCacheBasePath()
  return connections.length === 1 ? base : base.replace(/\.json$/i, `.${connection}.json`)
}

/** Candidate paths for a connection (exact name, then lowercase suffix for legacy files). */
export function resolveCatalogCachePathCandidates(
  connection: string,
  connections: readonly string[],
): string[] {
  const paths = [resolveCatalogCachePath(connection, connections)]
  if (connections.length > 1) {
    const lower = resolveCatalogCacheBasePath().replace(/\.json$/i, `.${connection.toLowerCase()}.json`)
    if (!paths.includes(lower)) paths.push(lower)
  }
  return paths
}

/** First existing catalog cache file for any configured connection. */
export function findExistingCatalogCachePath(connections: readonly string[]): string | null {
  if (connections.length === 0) return null
  for (const connection of connections) {
    for (const path of resolveCatalogCachePathCandidates(connection, connections)) {
      if (existsSync(path)) return path
    }
  }
  return null
}
