import { CatalogGraph } from "./graph.js"
import type { CatalogBuildOptions, CatalogSnapshot, ViewLineage } from "./types.js"

// ── Global catalog store (per connection, with disk cache) ───────

const _catalogs = new Map<string, CatalogGraph>()
let _defaultCachePath: string | undefined
let _defaultLineagePath: string | undefined  // remembered so refresh=true can re-apply lineage

/**
 * Build or load the catalog.  If a cachePath is provided and a fresh-enough
 * cache file exists, loads from disk (milliseconds).  Otherwise introspects
 * MSSQL (seconds) and writes the cache for next time.
 *
 * Accepts a string (connection name, backward compat) or CatalogBuildOptions.
 */
export async function buildCatalog(opts?: string | CatalogBuildOptions): Promise<CatalogGraph> {
  const o: CatalogBuildOptions = typeof opts === "string" ? { connection: opts } : (opts ?? {})
  const conn = o.connection ?? "default"
  const cachePath = o.cachePath ?? _defaultCachePath
  const maxAge = o.maxAgeMs ?? 7 * 24 * 3600_000  // 7 days default
  if (o.cachePath) _defaultCachePath = o.cachePath  // remember for refresh calls

  // Try loading from persistent cache (unless forceFresh)
  if (cachePath && !o.forceFresh) {
    try {
      const fs = await import("node:fs/promises")
      const stat = await fs.stat(cachePath)
      if (Date.now() - stat.mtimeMs < maxAge) {
        const raw = await fs.readFile(cachePath, "utf-8")
        const snap: CatalogSnapshot = JSON.parse(raw)
        if (snap.version === 1 || snap.version === 2 || snap.version === 3 || snap.version === 4 || snap.version === 5) {
          const catalog = CatalogGraph.fromSnapshot(snap)
          _catalogs.set(conn, catalog)
          return catalog
        }
      }
    } catch { /* no cache or invalid — build fresh */ }
  }

  // Build from live database (expensive — 3 SQL queries)
  const catalog = await CatalogGraph.build(conn)
  _catalogs.set(conn, catalog)

  // Re-apply lineage after a forced rebuild so the in-memory graph stays consistent
  // (lineage is loaded after buildCatalog at startup, so _defaultLineagePath is set)
  if (o.forceFresh && _defaultLineagePath) {
    try {
      const fsNode = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const raw = await fsNode.readFile(resolve(_defaultLineagePath), "utf-8")
      const lineages: ViewLineage[] = JSON.parse(raw)
      catalog.mergeLineage(lineages)
    } catch { /* non-fatal: lineage file may have been deleted */ }
  }

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
export function getCatalog(connection = "default"): CatalogGraph | null {
  return _catalogs.get(connection) ?? null
}

export function hasCatalog(): boolean {
  return _catalogs.size > 0
}

export function getCatalogPromptSummary(connection = "default"): string {
  return _catalogs.get(connection)?.promptSummary() ?? ""
}

/**
 * Load lineage definitions from a JSON file and merge into the catalog.
 * Call this after buildCatalog() — lineage is curated, not auto-discovered.
 */
export async function loadLineage(
  filePath: string,
  connection = "default",
): Promise<number> {
  _defaultLineagePath = filePath  // remember for re-apply after refresh=true
  const catalog = _catalogs.get(connection)
  if (!catalog) throw new Error("Catalog not built yet — call buildCatalog() first")

  const fs = await import("node:fs/promises")
  const { resolve } = await import("node:path")
  const resolved = resolve(filePath)
  const raw = await fs.readFile(resolved, "utf-8")
  const lineages: ViewLineage[] = JSON.parse(raw)
  catalog.mergeLineage(lineages)

  // Re-persist the snapshot so lineage is cached with structural data
  const cachePath = _defaultCachePath
  if (cachePath) {
    try {
      const { dirname } = await import("node:path")
      await fs.mkdir(dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, JSON.stringify(catalog.toSnapshot(connection)), "utf-8")
    } catch { /* non-fatal */ }
  }

  return lineages.length
}
