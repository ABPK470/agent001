/**
 * Tenant config — load, override, reset.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_TENANT_CONFIG,
  formatTenantConfigBootSummary,
  getTenantConfig,
  isDefaultTenantConfig,
  loadTenantConfigFromEnv,
  loadTenantConfigFromFile,
  resetTenantConfig,
  resolveTenantConfigPath,
  setTenantConfig
} from "../src/domain/tenant/tenant-config.js"

// Global setup (tests/setup.ts) overrides the tenant config to match the
// fixture catalog. Reset before AND after each test so this file always
// sees the pristine default.
beforeEach(() => resetTenantConfig())
afterEach(() => resetTenantConfig())

describe("tenant config defaults", () => {
  it("returns the frozen default when nothing has been loaded", () => {
    expect(getTenantConfig()).toBe(DEFAULT_TENANT_CONFIG)
    expect(isDefaultTenantConfig()).toBe(true)
  })

  it("ships an empty mirror schema and empty schema ranking by default", () => {
    const c = getTenantConfig()
    expect(c.mirrorSchema).toBeNull()
    expect(c.catalogBootstrap.largeObjects).toEqual([])
    expect(c.catalogBootstrap.canonicalQualifiedNames).toEqual({})
    expect(c.schemaRanking).toEqual([])
    expect(c.domainKeywords).toEqual([])
  })

  it("default thresholds match the universal heuristics", () => {
    expect(DEFAULT_TENANT_CONFIG.largeObjectRows).toBe(10_000_000)
    expect(DEFAULT_TENANT_CONFIG.unionBranchThreshold).toBe(8)
  })
})

describe("setTenantConfig", () => {
  it("merges partial overrides onto defaults", () => {
    setTenantConfig({ mirrorSchema: "myMirror" })
    const c = getTenantConfig()
    expect(c.mirrorSchema).toBe("myMirror")
    expect(c.catalogBootstrap.largeObjects).toEqual([])
    expect(c.largeObjectRows).toBe(DEFAULT_TENANT_CONFIG.largeObjectRows)
  })

  it("accepts explicit catalog bootstrap metadata", () => {
    setTenantConfig({
      catalogBootstrap: {
        largeObjects: ["publish.revenue"],
        canonicalQualifiedNames: { "publish.revenue": "publish.Revenue" },
        unionBranchCounts: { "publish.revenue": 12 },
        highCardinalityKeys: { "publish.revenue": ["pkClient"] }
      }
    })
    const c = getTenantConfig()
    expect(c.catalogBootstrap.largeObjects).toEqual(["publish.revenue"])
    expect(c.catalogBootstrap.unionBranchCounts).toEqual({ "publish.revenue": 12 })
  })

  it("deep-freezes nested arrays", () => {
    setTenantConfig({ schemaRanking: [{ schema: "x", weight: 1 }] })
    const c = getTenantConfig()
    expect(Object.isFrozen(c.schemaRanking)).toBe(true)
    expect(Object.isFrozen(c.schemaRanking[0])).toBe(true)
  })

  it("isDefaultTenantConfig becomes false after override", () => {
    setTenantConfig({ unionBranchThreshold: 999 })
    expect(isDefaultTenantConfig()).toBe(false)
  })
})

describe("loadTenantConfigFromEnv", () => {
  it("returns defaults when MIA_TENANT_CONFIG is unset", () => {
    expect(loadTenantConfigFromEnv({})).toBe(DEFAULT_TENANT_CONFIG)
  })

  it("loads from the path supplied via env", () => {
    const path = join(tmpdir(), `tenant-test-${Date.now()}.json`)
    writeFileSync(path, JSON.stringify({ mirrorSchema: "envMirror", unionBranchThreshold: 4 }))
    const c = loadTenantConfigFromEnv({ MIA_TENANT_CONFIG: path } as NodeJS.ProcessEnv)
    expect(c.mirrorSchema).toBe("envMirror")
    expect(c.unionBranchThreshold).toBe(4)
    expect(c.largeObjectRows).toBe(DEFAULT_TENANT_CONFIG.largeObjectRows)
  })

  it("throws a clear error on invalid JSON", () => {
    const path = join(tmpdir(), `tenant-bad-${Date.now()}.json`)
    writeFileSync(path, "{ not json")
    expect(() => loadTenantConfigFromEnv({ MIA_TENANT_CONFIG: path } as NodeJS.ProcessEnv)).toThrow()
  })

  it("throws when the config file does not exist", () => {
    expect(() =>
      loadTenantConfigFromEnv({ MIA_TENANT_CONFIG: "/no/such/tenant.json" } as NodeJS.ProcessEnv)
    ).toThrow(/not found/)
  })

  it("resolves relative paths against baseDir", () => {
    const dir = join(tmpdir(), `tenant-base-${Date.now()}`)
    mkdirSync(dir, { recursive: true })
    const path = join(dir, "tenant.json")
    writeFileSync(path, JSON.stringify({ mirrorSchema: "relativeMirror" }), { flag: "wx" })
    const c = loadTenantConfigFromEnv(
      { MIA_TENANT_CONFIG: "tenant.json" } as NodeJS.ProcessEnv,
      { baseDir: dir }
    )
    expect(c.mirrorSchema).toBe("relativeMirror")
    expect(resolveTenantConfigPath("tenant.json", dir)).toBe(path)
  })
})

describe("formatTenantConfigBootSummary", () => {
  it("includes mirror and keyword counts", () => {
    setTenantConfig({
      mirrorSchema: "persistedview",
      domainKeywords: ["revenue", "risk", "mymi"]
    })
    const summary = formatTenantConfigBootSummary()
    expect(summary).toContain("mirror=persistedview")
    expect(summary).toContain("domainKeywords=3")
    expect(summary).not.toContain("syncEntities=")
  })
})

describe("resetTenantConfig", () => {
  it("restores defaults", () => {
    setTenantConfig({ largeObjectRows: 1 })
    expect(getTenantConfig().largeObjectRows).toBe(1)
    resetTenantConfig()
    expect(getTenantConfig()).toBe(DEFAULT_TENANT_CONFIG)
  })
})
