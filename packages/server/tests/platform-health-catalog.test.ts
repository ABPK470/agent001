import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { configureAgent } from "@mia/agent"

import { findExistingCatalogCachePath } from "../src/platform/catalog/catalog-cache-path.js"
import { getPlatformHealth } from "../src/features/platform/application/platform-health-service.js"

describe("catalog cache discovery", () => {
  const originalDataDir = process.env.MIA_DATA_DIR
  let dataDir: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "mia-catalog-"))
    process.env.MIA_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.MIA_DATA_DIR
    else process.env.MIA_DATA_DIR = originalDataDir
    rmSync(dataDir, { recursive: true, force: true })
  })

  it("finds per-connection cache files by connection name", () => {
    writeFileSync(join(dataDir, "catalog-cache.dev.json"), '{"stats":{"tables":1,"fks":0}}')
    expect(findExistingCatalogCachePath(["dev", "uat"])).toBe(join(dataDir, "catalog-cache.dev.json"))
  })

  it("falls back to lowercase suffix when exact case differs", () => {
    writeFileSync(join(dataDir, "catalog-cache.uat.json"), '{"stats":{"tables":2,"fks":1}}')
    expect(findExistingCatalogCachePath(["UAT", "DEV"])).toMatch(/catalog-cache\.uat\.json$/i)
  })
})

describe("getPlatformHealth catalog", () => {
  const originalDataDir = process.env.MIA_DATA_DIR
  let dataDir: string
  let projectRoot: string
  let testDb: Database.Database

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "mia-health-"))
    projectRoot = mkdtempSync(join(tmpdir(), "mia-proj-"))
    mkdirSync(join(projectRoot, "deploy/sync/artifacts"), { recursive: true })
    process.env.MIA_DATA_DIR = dataDir
    process.env.LLM_PROVIDER = "copilot-chat"

    testDb = new Database(":memory:")
    const { _setDb, _migrate } = await import("../src/platform/persistence/connection.js")
    _setDb(testDb)
    _migrate(testDb)
  })

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.MIA_DATA_DIR
    else process.env.MIA_DATA_DIR = originalDataDir
    testDb.close()
    const { _setDb } = await import("../src/platform/persistence/connection.js")
    _setDb(null as unknown as Database.Database)
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  it("does not treat mssql summary text as connection names", () => {
    writeFileSync(
      join(dataDir, "catalog-cache.dev.json"),
      JSON.stringify({ stats: { tables: 10, fks: 3 } }),
    )

    const host = configureAgent({
      mssqlConfigs: [
        {
          name: "dev",
          server: "sql.example.com",
          port: 1433,
          user: "sa",
          password: "",
          database: "mymi",
          options: { encrypt: false, trustServerCertificate: true },
          writeEnabled: false,
          knowledge: null,
        },
        {
          name: "uat",
          server: "sql2.example.com",
          port: 1433,
          user: "sa",
          password: "",
          database: "mymi",
          options: { encrypt: false, trustServerCertificate: true },
          writeEnabled: false,
          knowledge: null,
        },
      ],
    })

    const summary = "dev(sql.example.com/mymi), uat(sql2.example.com/mymi)"
    const health = getPlatformHealth(projectRoot, summary, host)
    expect(health.catalog.available).toBe(true)
    expect(health.catalog.detail).toContain("10 tables")
  })
})
