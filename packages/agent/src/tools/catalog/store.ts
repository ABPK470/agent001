import { currentRuntime } from "../../agent-runtime.js"
import { CatalogGraph } from "./graph/index.js"
import { validateCuratedLineage } from "./lineage-validator.js"
import type { CatalogBuildOptions, CatalogSnapshot, ViewLineage } from "./types.js"

// ── Global catalog store (per connection, with disk cache) ───────

// Catalog instances live on the active AgentRuntime
// (`currentRuntime().catalog.instances`). They are populated lazily by
// `buildCatalog()` and shared across calls in the same runtime.
// State container — `const` reference to a mutable record so the lint rule
// banning module-level `let` passes while preserving the existing singleton
// shape. The state can be migrated into AgentRuntime sub-runtimes later.

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
  const cachePath = o.cachePath ?? currentRuntime().catalog.defaultCachePath
  const maxAge = o.maxAgeMs ?? 7 * 24 * 3600_000  // 7 days default
  if (o.cachePath) currentRuntime().catalog.defaultCachePath = o.cachePath  // remember for refresh calls

  // Try loading from persistent cache (unless forceFresh)
  if (cachePath && !o.forceFresh) {
    try {
      const fs = await import("node:fs/promises")
      const stat = await fs.stat(cachePath)
      if (Date.now() - stat.mtimeMs < maxAge) {
        const raw = await fs.readFile(cachePath, "utf-8")
        const snap: CatalogSnapshot = JSON.parse(raw)
        if (snap.version === 6) {
          const catalog = CatalogGraph.fromSnapshot(snap)
          currentRuntime().catalog.instances.set(conn, catalog)
          return catalog
        }
      }
    } catch { /* no cache or invalid — build fresh */ }
  }

  // Build from live database (expensive — 5 SQL queries)
  const catalog = await CatalogGraph.build(conn)
  currentRuntime().catalog.instances.set(conn, catalog)

  // Re-apply lineage after a forced rebuild so the in-memory graph stays consistent
  // (lineage is loaded after buildCatalog at startup, so the runtime's defaultLineagePath is set)
  const lineagePath = currentRuntime().catalog.defaultLineagePath
  if (o.forceFresh && lineagePath) {
    try {
      const fsNode = await import("node:fs/promises")
      const { resolve } = await import("node:path")
      const raw = await fsNode.readFile(resolve(lineagePath), "utf-8")
      const lineages: ViewLineage[] = JSON.parse(raw)
      // Validate (see lineage-validator.ts) and merge with precedence:
      // skip JSON entries that the live DB has already supplied via
      // extended properties (those were merged inside CatalogGraph.build).
      const { validated } = validateCuratedLineage(lineages, catalog, conn)
      const toMerge: ViewLineage[] = []
      for (const entry of validated) {
        const existing = catalog.getLineage(entry.view)
        if (existing && existing.provenance === "extended-properties") {
          // eslint-disable-next-line no-console
          console.warn(`[lineage:redundant-json] ${entry.view} curated via extended properties — JSON entry ignored.`)
          continue
        }
        toMerge.push({ ...entry, provenance: "curation-file" })
      }
      catalog.mergeLineage(toMerge)
    } catch { /* non-fatal: curation file may have been deleted */ }
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
  // Exact match first
  const exact = currentRuntime().catalog.instances.get(connection)
  if (exact) return exact
  // In multi-database mode, connections are named (e.g. "uat", "dev") and
  // there is no "default" entry. Fall back to the first available catalog so
  // tools that don't pass an explicit connection= still work.
  if (connection === "default" && currentRuntime().catalog.instances.size > 0) {
    return currentRuntime().catalog.instances.values().next().value ?? null
  }
  return null
}

/** Return the name of every loaded connection, in insertion order. */
export function getCatalogConnectionNames(): string[] {
  return Array.from(currentRuntime().catalog.instances.keys())
}

export function hasCatalog(): boolean {
  return currentRuntime().catalog.instances.size > 0
}

export function getCatalogPromptSummary(connection = "default"): string {
  return getCatalog(connection)?.promptSummary() ?? ""
}

/**
 * Stable schema fingerprint of the named catalog, or `null` when no
 * catalog has been built yet. Cheap, pure — safe to call on every
 * memory write.
 */
export function getCatalogSchemaFingerprint(connection = "default"): string | null {
  return getCatalog(connection)?.schemaFingerprint() ?? null
}

/**
 * Load lineage definitions from a JSON file and merge into the catalog.
 * Call this after buildCatalog() — lineage is curated, not auto-discovered.
 */
export async function loadLineage(
  filePath: string,
  connection = "default",
): Promise<number> {
  currentRuntime().catalog.defaultLineagePath = filePath  // remember for re-apply after refresh=true
  const catalog = currentRuntime().catalog.instances.get(connection)
  if (!catalog) throw new Error("Catalog not built yet — call buildCatalog() first")

  const fs = await import("node:fs/promises")
  const { resolve } = await import("node:path")
  const resolved = resolve(filePath)
  const raw = await fs.readFile(resolved, "utf-8")
  const lineages: ViewLineage[] = JSON.parse(raw)
  // Validate curated lineage against the live catalog before it reaches the
  // agent — the curation file has no automatic refresh and drifts silently as
  // schema evolves. validateCuratedLineage prunes stale fields, demotes
  // entries whose view is gone, and stamps a drift report on each.
  const { validated } = validateCuratedLineage(lineages, catalog, connection)
  // Precedence: an extended-property entry already loaded from the live DB
  // is the source of truth (DBA-authored, co-located with the schema).
  // Skip JSON entries that would overwrite one, and log so the DBA knows
  // the JSON entry is now redundant and can be removed from the curation file.
  const toMerge: ViewLineage[] = []
  for (const entry of validated) {
    const existing = catalog.getLineage(entry.view)
    if (existing && existing.provenance === "extended-properties") {
      // eslint-disable-next-line no-console
      console.warn(`[lineage:redundant-curation] ${entry.view} is now curated via SQL extended properties on the live DB — remove from ${filePath} to avoid double maintenance.`)
      continue
    }
    toMerge.push({ ...entry, provenance: "curation-file" })
  }
  catalog.mergeLineage(toMerge)

  // Re-persist the snapshot so lineage is cached with structural data
  const cachePath = currentRuntime().catalog.defaultCachePath
  if (cachePath) {
    try {
      const { dirname } = await import("node:path")
      await fs.mkdir(dirname(cachePath), { recursive: true })
      await fs.writeFile(cachePath, JSON.stringify(catalog.toSnapshot(connection)), "utf-8")
    } catch { /* non-fatal */ }
  }

  return lineages.length
}
