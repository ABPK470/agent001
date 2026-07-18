/**
 * Authored compile export — B → A per entity (process JSON / import-compat).
 */

import Database from "better-sqlite3"
import { tmpdir } from "node:os"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"
import { loadSyncDefinitionFlowTemplateCatalog } from "@mia/sync"

import { ensureSyncDefinitionConfigs } from "../src/api/sync/service/definitions.js"
import {
  entityToAuthoredSyncDefinition,
  formatAuthoredSyncJson,
  syncConfigInputFromDb,
} from "../src/api/sync/types/authored-sync-document.js"
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
    "flow-templates.json",
    "sync-definition-configs.json",
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

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), "artifact-export-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "artifact-export-root-"))
  seedRepoArtifacts(projectRoot)

  const { seedEntityRegistryIfEmpty } = await import(
    "../src/api/sync/service/seed-entity-registry.js"
  )
  const { seedSyncMetadataIfEmpty } = await import(
    "../src/api/sync/service/seed-sync-metadata.js"
  )
  seedEntityRegistryIfEmpty(projectRoot)
  seedSyncMetadataIfEmpty(projectRoot)
  ensureSyncDefinitionConfigs(projectRoot)
}

describe("deploy artifact export (B → A)", () => {
  beforeEach(async () => {
    await setupDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("exports dataset as AuthoredSyncDefinition matching EntityDefinition seed tables", () => {
    const seedPath = resolve(projectRoot, "deploy/sync/artifacts/entities/dataset.json")
    const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as {
      rootTable: string
      idColumn: string
      tables: Array<{ name: string }>
    }

    const entity = db.getEntityDefinition("_default", "dataset")
    expect(entity).toBeTruthy()

    const configRow = db.getSyncDefinitionConfig("_default", "dataset")
    expect(configRow).toBeTruthy()

    const catalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const authored = entityToAuthoredSyncDefinition(
      entity!,
      catalog,
      syncConfigInputFromDb(configRow!),
    )
    const exported = JSON.parse(formatAuthoredSyncJson(authored)) as AuthoredSyncDefinition

    expect(exported.id).toBe("dataset")
    expect(exported.schemaVersion).toBe(1)
    expect(exported.rootTable).toBe(seed.rootTable)
    expect(exported.idColumn).toBe(seed.idColumn)
    expect(exported.metadata.tables.length).toBe(seed.tables.length)
    expect(exported.executionFlow.steps.length).toBeGreaterThan(0)
    expect(exported.bindings.serviceProfileRef).toBe(configRow!.service_profile_ref)
    expect(exported.bindings.environmentPolicyRef).toBe(configRow!.environment_policy_ref)
  })

  it("includes execution flow steps from sync definition config", () => {
    const entity = db.getEntityDefinition("_default", "contract")
    const configRow = db.getSyncDefinitionConfig("_default", "contract")
    const catalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)

    const authored = entityToAuthoredSyncDefinition(
      entity!,
      catalog,
      syncConfigInputFromDb(configRow!),
    )

    expect(authored.executionFlow.steps.length).toBeGreaterThan(1)
    expect(authored.metadata.executionOrder[0]).toBeTruthy()
  })
})
