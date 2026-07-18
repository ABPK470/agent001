import { describe, expect, it } from "vitest"
import {
  classifyCatalogVersionReason,
  countActiveCatalogVersionFilters,
  DEFAULT_CATALOG_VERSION_FILTERS,
  filterCatalogVersions,
  type CatalogVersionEntry,
} from "./catalog-version-filters"

const SAMPLE: CatalogVersionEntry[] = [
  {
    tenantId: "_default",
    version: 4,
    reason: "sync-metadata:wiring:testWIRING",
    createdBy: "pka",
    createdAt: "2026-07-18T10:18:09.000Z",
    isActive: true,
  },
  {
    tenantId: "_default",
    version: 3,
    reason: "entity-registry:import:d",
    createdBy: "pka",
    createdAt: "2026-07-18T10:17:00.000Z",
    isActive: false,
  },
  {
    tenantId: "_default",
    version: 1,
    reason: "seed:initial",
    createdBy: "system",
    createdAt: "2026-07-17T08:00:00.000Z",
    isActive: false,
  },
]

describe("classifyCatalogVersionReason", () => {
  it("maps known reason prefixes", () => {
    expect(classifyCatalogVersionReason("seed:initial")).toBe("seed")
    expect(classifyCatalogVersionReason("entity-registry:save:x")).toBe("entity-registry")
    expect(classifyCatalogVersionReason("sync-metadata:wiring:x")).toBe("sync-metadata")
    expect(classifyCatalogVersionReason("rollback:from:2")).toBe("rollback")
    expect(classifyCatalogVersionReason("catalog:import:zip")).toBe("import")
  })
})

describe("filterCatalogVersions", () => {
  it("filters by kind and search", () => {
    const rows = filterCatalogVersions(SAMPLE, {
      ...DEFAULT_CATALOG_VERSION_FILTERS,
      kinds: ["seed"],
      q: "system",
    })
    expect(rows.map((r) => r.version)).toEqual([1])
  })

  it("keeps only active when requested", () => {
    const rows = filterCatalogVersions(SAMPLE, {
      ...DEFAULT_CATALOG_VERSION_FILTERS,
      activeOnly: true,
    })
    expect(rows.map((r) => r.version)).toEqual([4])
  })
})

describe("countActiveCatalogVersionFilters", () => {
  it("counts non-default filters", () => {
    expect(countActiveCatalogVersionFilters(DEFAULT_CATALOG_VERSION_FILTERS, "")).toBe(0)
    expect(
      countActiveCatalogVersionFilters(
        { ...DEFAULT_CATALOG_VERSION_FILTERS, activeOnly: true, actor: "pka" },
        "wiring",
      ),
    ).toBe(3)
  })
})
