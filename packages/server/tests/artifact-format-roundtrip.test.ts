/**
 * Integration tests — Catalog snapshot + registry JSON round-trips.
 */

import Database from "better-sqlite3"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  applyDeployCatalogSnapshot,
  validateDeployCatalogSnapshot,
} from "../src/api/platform/service/import-deploy-artifacts.js"
import { buildDeployCatalogSnapshot } from "../src/api/platform/service/export-deploy-artifacts.js"
import { formatEntityJson, parseEntitiesJson } from "../src/api/sync/types/entity-yaml.js"
import * as db from "../src/infra/persistence/db/index.js"

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

function seedRepoArtifacts(root: string): void {
  const repoDeploySync = resolve(fileURLToPath(new URL("../../../deploy/sync", import.meta.url)))
  const targetDeploySync = resolve(root, "deploy/sync")
  mkdirSync(join(targetDeploySync, "artifacts", "entities"), { recursive: true })

  const entitiesDir = join(repoDeploySync, "artifacts", "entities")
  if (existsSync(entitiesDir)) {
    for (const name of readdirSync(entitiesDir).filter((file) => file.endsWith(".json"))) {
      copyFileSync(join(entitiesDir, name), join(targetDeploySync, "artifacts", "entities", name))
    }
  }

  for (const name of [
    "sync-metadata.json",
    "strategies.json",
      ]) {
    const source = join(repoDeploySync, "artifacts", name)
    if (existsSync(source)) {
      copyFileSync(source, join(targetDeploySync, "artifacts", name))
    }
  }

  const envSource = join(repoDeploySync, "sync-environments.json")
  if (existsSync(envSource)) {
    copyFileSync(envSource, join(targetDeploySync, "sync-environments.json"))
  }
}

async function setupSeededDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), "catalog-roundtrip-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "catalog-roundtrip-root-"))
  seedRepoArtifacts(projectRoot)

  const { seedEntityRegistryIfEmpty } = await import(
    "../src/api/sync/service/seed-entity-registry.js"
  )
  const { seedSyncMetadataIfEmpty } = await import(
    "../src/api/sync/service/seed-sync-metadata.js"
  )
  seedEntityRegistryIfEmpty(projectRoot)
  seedSyncMetadataIfEmpty(projectRoot)
}

describe("catalog format round-trip integration", () => {
  beforeEach(async () => {
    await setupSeededDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("B → registry JSON → B preserves structured fields", () => {
    const entity = db.getEntityDefinition("_default", "contract")
    expect(entity).toBeTruthy()
    const json = formatEntityJson(entity!)
    const parsed = parseEntitiesJson(json)
    expect(parsed[0]?.ok).toBe(true)
    expect(parsed[0]?.def?.tables.length).toBe(entity!.tables.length)
    expect(parsed[0]?.def?.flowId).toBe(entity!.flowId)
  })

  it("catalog snapshot B bulk export/import round-trip still works", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: "_default" })
    expect(validateDeployCatalogSnapshot(snapshot).ok).toBe(true)
    const expectedFlowId = db.getEntityDefinition("_default", "dataset")?.flowId
    expect(expectedFlowId).toBeTruthy()

    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "test",
      projectRoot,
      dryRun: false,
    })
    expect(applied.applied).toBe(true)
    expect(db.getEntityDefinition("_default", "dataset")?.flowId).toBe(expectedFlowId)
  })

  it("catalog snapshot export/import restores retired entities", () => {
    const snapshot = buildDeployCatalogSnapshot({
      tenantId: "_default",
      includeRetiredEntities: true,
    })

    for (const row of db.listEntityDefinitions("_default")) {
      db.retireEntityDefinition("_default", row.id, "test")
    }
    expect(db.listEntityDefinitions("_default").length).toBe(0)

    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "test",
      projectRoot,
      dryRun: false,
    })
    expect(applied.applied).toBe(true)
    expect(db.listEntityDefinitions("_default").length).toBeGreaterThan(0)
  })
})
