import type { AgentHost } from "../../application/shell/runtime.js"
import { CatalogGraph } from "./graph/index.js"
import type { CatalogBuildOptions, CatalogSnapshot } from "./types.js"

// ── Catalog store (per connection, with disk cache) ──────────────
//
// Catalog instances live on `host.catalog.instances` (a Map populated
// lazily by `buildCatalog`). All accessors take `host` as the first
// parameter — no module-level state.

/**
 * Build or load the catalog.  If a cachePath is provided and a fresh-enough
 * cache file exists, loads from disk (milliseconds).  Otherwise introspects
 * MSSQL (seconds) and writes the cache for next time.
 *
 * Accepts a string (connection name, backward compat) or CatalogBuildOptions.
 */
export async function buildCatalog(host: AgentHost, opts?: string | CatalogBuildOptions): Promise<CatalogGraph> {
  const o: CatalogBuildOptions = typeof opts === "string" ? { connection: opts } : (opts ?? {})
  const conn = o.connection ?? "default"
  const cachePath = o.cachePath ?? host.catalog.defaultCachePath.value
  const maxAge = o.maxAgeMs ?? 7 * 24 * 3600_000  // 7 days default
  if (o.cachePath) host.catalog.defaultCachePath.value = o.cachePath  // remember for refresh calls

  // Try loading from persistent cache (unless forceFresh)
  if (cachePath && !o.forceFresh) {
    try {
      const fs = await import("node:fs/promises")
      const stat = await fs.stat(cachePath)
      if (Date.now() - stat.mtimeMs < maxAge) {
        const raw = await fs.readFile(cachePath, "utf-8")
        const snap: CatalogSnapshot = JSON.parse(raw)
        if (snap.version === 7) {
          const catalog = CatalogGraph.fromSnapshot(snap)
          host.catalog.instances.set(conn, catalog)
          return catalog
        }
      }
    } catch { /* no cache or invalid — build fresh */ }
  }

  // Build from live database (expensive — 5 SQL queries)
  const catalog = await CatalogGraph.build(host, conn)
  host.catalog.instances.set(conn, catalog)

  // Persist to cache for next startup
  if (cachePath) {
    try {
      const fs = await import("node:fs/promises")
      const { dirname } = await import("node:path")
      await fs.mkdir(dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, JSON.stringify(catalog.toSnapshot(conn)), "utf-8")
    } catch { /* cache write failure is non-fatal */ }
  }

  return catalog
}

/** Get a previously built/loaded catalog. */
export function getCatalog(host: AgentHost, connection = "default"): CatalogGraph | null {
  // Exact match first
  const exact = host.catalog.instances.get(connection)
  if (exact) return exact
  // In multi-database mode, connections are named (e.g. "uat", "dev") and
  // there is no "default" entry. Fall back to the first available catalog so
  // tools that don't pass an explicit connection= still work.
  if (connection === "default" && host.catalog.instances.size > 0) {
    return host.catalog.instances.values().next().value ?? null
  }
  return null
}

/** Return the name of every loaded connection, in insertion order. */
export function getCatalogConnectionNames(host: AgentHost): string[] {
  return Array.from(host.catalog.instances.keys())
}

export function hasCatalog(host: AgentHost): boolean {
  return host.catalog.instances.size > 0
}

export function getCatalogPromptSummary(host: AgentHost, connection = "default"): string {
  return getCatalog(host, connection)?.promptSummary() ?? ""
}

/**
 * Stable schema fingerprint of the named catalog, or `null` when no
 * catalog has been built yet. Cheap, pure — safe to call on every
 * memory write.
 */
export function getCatalogSchemaFingerprint(host: AgentHost, connection = "default"): string | null {
  return getCatalog(host, connection)?.schemaFingerprint() ?? null
}
