/**
 * Process-JSON compile (B → AuthoredSyncDefinition) — scaffold / Publish intermediate.
 */

import Database from "better-sqlite3"
import { tmpdir } from "node:os"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { compileAuthoredSyncDefinition, loadSyncDefinitionFlowTemplateCatalog } from "@mia/sync"

import { syncDefinitionConfigFromEntity } from "@mia/sync"
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

  for (const name of ["sync-metadata.json", "strategies.json"]) {
    const source = join(repoDeploySync, "artifacts", name)
    if (existsSync(source)) {
      copyFileSync(source, join(targetDeploySync, "artifacts", name))
    }
  }
}

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), "authored-compile-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "authored-compile-root-"))
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

describe("Authored process-JSON compile (B → A)", () => {
  beforeEach(async () => {
    await setupDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("compiles dataset EntityDefinition into AuthoredSyncDefinition with matching tables", () => {
    const entity = db.getEntityDefinition("_default", "dataset")
    expect(entity).toBeTruthy()

    const catalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const authored = compileAuthoredSyncDefinition(entity!, {
      flowTemplateCatalog: catalog,
      config: syncDefinitionConfigFromEntity(entity!, catalog),
      sourceArtifact: `deploy/sync/artifacts/entities/${entity!.id}.json`,
    })

    expect(authored.id).toBe("dataset")
    expect(authored.rootTable).toBe(entity!.rootTable)
    expect(authored.metadata.tables.length).toBe(entity!.tables.length)
  })

  it("includes execution flow steps from entity.flowId", () => {
    const entity = db.getEntityDefinition("_default", "content")
    expect(entity).toBeTruthy()
    const catalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const authored = compileAuthoredSyncDefinition(entity!, {
      flowTemplateCatalog: catalog,
      config: syncDefinitionConfigFromEntity(entity!, catalog),
    })
    expect(authored.executionFlow.steps.length).toBeGreaterThan(0)
  })
})
