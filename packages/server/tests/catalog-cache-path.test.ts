import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  findExistingCatalogCachePath,
  resolveCatalogCacheBasePath,
  resolveCatalogCachePath,
  resolveServerDataDir,
} from "../src/platform/catalog/catalog-cache-path.js"

describe("catalog cache paths", () => {
  const originalDataDir = process.env.MIA_DATA_DIR

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.MIA_DATA_DIR
    else process.env.MIA_DATA_DIR = originalDataDir
  })

  it("defaults to ~/.mia/catalog-cache.json", () => {
    delete process.env.MIA_DATA_DIR
    expect(resolveServerDataDir()).toBe(join(homedir(), ".mia"))
    expect(resolveCatalogCacheBasePath()).toBe(join(homedir(), ".mia", "catalog-cache.json"))
  })

  it("honours MIA_DATA_DIR", () => {
    process.env.MIA_DATA_DIR = "/var/mia"
    expect(resolveServerDataDir()).toBe("/var/mia")
    expect(resolveCatalogCacheBasePath()).toBe("/var/mia/catalog-cache.json")
  })

  it("suffixes per-connection cache files when multiple connections", () => {
    expect(resolveCatalogCachePath("UAT", ["DEV", "UAT"])).toMatch(/catalog-cache\.UAT\.json$/)
  })

  it("uses a single file when only one connection", () => {
    expect(resolveCatalogCachePath("DEV", ["DEV"])).toMatch(/catalog-cache\.json$/)
    expect(resolveCatalogCachePath("DEV", ["DEV"])).not.toMatch(/catalog-cache\.dev\.json$/)
  })
})
