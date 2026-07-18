/**
 * Client-side filters for configuration (sync catalog) versions.
 */

/**
 * One-word kind ids + labels (UI filter dialect).
 * Version `reason` prefixes stay machine-shaped (`entity-registry:…`, `sync-metadata:…`);
 * {@link classifyCatalogVersionReason} maps those onto these kinds.
 */
export type CatalogVersionKind =
  | "seed"
  | "entities"
  | "metadata"
  | "rollback"
  | "import"
  | "other"

export type CatalogVersionSort =
  | "version_desc"
  | "version_asc"
  | "created_desc"
  | "created_asc"

export type CatalogVersionEntry = {
  tenantId: string
  version: number
  reason: string
  createdBy: string
  createdAt: string
  isActive: boolean
}

export type CatalogVersionFilters = {
  q?: string
  from?: string
  to?: string
  actor?: string
  kinds?: CatalogVersionKind[]
  sort: CatalogVersionSort
}

export const DEFAULT_CATALOG_VERSION_FILTERS: CatalogVersionFilters = {
  sort: "version_desc",
}

export const CATALOG_VERSION_KIND_OPTIONS: Array<{ value: CatalogVersionKind; label: string }> = [
  { value: "seed", label: "Seed" },
  { value: "entities", label: "Entities" },
  { value: "metadata", label: "Metadata" },
  { value: "rollback", label: "Rollback" },
  { value: "import", label: "Import" },
  { value: "other", label: "Other" },
]

export const CATALOG_VERSION_SORT_OPTIONS: Array<{ value: CatalogVersionSort; label: string }> = [
  { value: "version_desc", label: "Newest" },
  { value: "version_asc", label: "Oldest" },
  { value: "created_desc", label: "Recent" },
  { value: "created_asc", label: "Earliest" },
]

export function classifyCatalogVersionReason(reason: string): CatalogVersionKind {
  const value = reason.trim().toLowerCase()
  if (value.startsWith("seed:")) return "seed"
  if (value.startsWith("rollback:")) return "rollback"
  if (value.startsWith("entity-registry:")) return "entities"
  if (value.startsWith("sync-metadata:")) return "metadata"
  if (value.includes("import") || value.startsWith("catalog:")) return "import"
  return "other"
}

export function countActiveCatalogVersionFilters(
  filters: CatalogVersionFilters,
  searchDraft: string,
): number {
  let count = 0
  if (searchDraft.trim()) count++
  if (filters.from?.trim()) count++
  if (filters.to?.trim()) count++
  if (filters.actor?.trim()) count++
  if (filters.kinds?.length) count++
  if (filters.sort !== DEFAULT_CATALOG_VERSION_FILTERS.sort) count++
  return count
}

function dayStartMs(isoDate: string): number | null {
  const trimmed = isoDate.trim()
  if (!trimmed) return null
  const ms = Date.parse(`${trimmed}T00:00:00`)
  return Number.isFinite(ms) ? ms : null
}

function dayEndMs(isoDate: string): number | null {
  const trimmed = isoDate.trim()
  if (!trimmed) return null
  const ms = Date.parse(`${trimmed}T23:59:59.999`)
  return Number.isFinite(ms) ? ms : null
}

export function filterCatalogVersions(
  versions: readonly CatalogVersionEntry[],
  filters: CatalogVersionFilters,
): CatalogVersionEntry[] {
  const q = filters.q?.trim().toLowerCase() ?? ""
  const actor = filters.actor?.trim().toLowerCase() ?? ""
  const kinds = new Set(filters.kinds ?? [])
  const fromMs = filters.from ? dayStartMs(filters.from) : null
  const toMs = filters.to ? dayEndMs(filters.to) : null

  const filtered = versions.filter((entry) => {
    if (actor && !entry.createdBy.toLowerCase().includes(actor)) return false
    if (kinds.size > 0 && !kinds.has(classifyCatalogVersionReason(entry.reason))) return false
    const createdMs = Date.parse(entry.createdAt)
    if (fromMs != null && Number.isFinite(createdMs) && createdMs < fromMs) return false
    if (toMs != null && Number.isFinite(createdMs) && createdMs > toMs) return false
    if (q) {
      const haystack = [
        `v${entry.version}`,
        String(entry.version),
        entry.reason,
        entry.createdBy,
        entry.isActive ? "active" : "",
      ]
        .join(" ")
        .toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  const sorted = [...filtered]
  sorted.sort((a, b) => {
    switch (filters.sort) {
      case "version_asc":
        return a.version - b.version
      case "created_desc":
        return Date.parse(b.createdAt) - Date.parse(a.createdAt)
      case "created_asc":
        return Date.parse(a.createdAt) - Date.parse(b.createdAt)
      case "version_desc":
      default:
        return b.version - a.version
    }
  })
  return sorted
}
