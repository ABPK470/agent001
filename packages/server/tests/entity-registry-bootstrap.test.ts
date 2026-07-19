/**
 * Fresh-database bootstrap: entity_active seeded from deploy artifacts.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "../../..")

let testDb: Database.Database
let dataDir: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "mia-entity-bootstrap-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

async function setup() {
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)
}

describe("entity registry bootstrap", () => {
  it("seeds all deploy artifact entities on an empty database", async () => {
    await setup()
    const { seedEntityRegistryIfEmpty } = await import(
      "../src/api/sync/service/seed-entity-registry.js"
    )
    const db = await import("../src/infra/persistence/sqlite.js")

    const result = seedEntityRegistryIfEmpty(repoRoot)
    expect(result.source).toBe("artifacts")
    expect(result.seeded).toBe(6)
    expect(result.entityIds.sort()).toEqual(
      ["content", "contract", "dataset", "gateMetadata", "pipelineActivity", "rule"].sort(),
    )

    const listed = db.listEntityDefinitions("_default")
    expect(listed).toHaveLength(6)
    expect(listed.find((e) => e.id === "contract")?.displayName).toBe("Contract")
  })

  it("is idempotent when entities already exist", async () => {
    await setup()
    const { seedEntityRegistryIfEmpty } = await import(
      "../src/api/sync/service/seed-entity-registry.js"
    )
    const db = await import("../src/infra/persistence/sqlite.js")

    const first = seedEntityRegistryIfEmpty(repoRoot)
    const second = seedEntityRegistryIfEmpty(repoRoot)

    expect(first.seeded).toBe(6)
    expect(second.seeded).toBe(0)
    expect(second.source).toBe("none")
    expect(db.listEntityDefinitions("_default")).toHaveLength(6)
  })

  it("seeds entities with flowId via boot hook (no configs table)", async () => {
    await setup()
    const { loadBootSyncEnvironments } = await import("../src/boot/sync-environments.js")
    const db = await import("../src/infra/persistence/sqlite.js")

    loadBootSyncEnvironments(repoRoot, [])

    const entities = db.listEntityDefinitions("_default")
    expect(entities.length).toBeGreaterThan(0)
    expect(entities.every((entity) => Boolean(entity.flowId?.trim()))).toBe(true)
  })

  it("seeds flow presets on a fresh database after migrations", async () => {
    await setup()
    const db = await import("../src/infra/persistence/sqlite.js")

    expect(db.listSyncFlows("_default")).toHaveLength(0)
    expect(db.syncCatalogEmpty("_default")).toBe(true)

    const { loadBootSyncEnvironments } = await import("../src/boot/sync-environments.js")
    loadBootSyncEnvironments(repoRoot, [])

    const presets = db.listSyncFlows("_default")
    expect(presets.length).toBe(7)
    expect(presets.map((p) => p.id).sort()).toEqual(
      ["content", "contract", "dataset", "gateMetadata", "metadataOnly", "pipelineActivity", "rule"].sort(),
    )
    expect(presets.every((p) => p.built_in === 1)).toBe(true)
  })
})
