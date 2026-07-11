/**
 * Bulk deploy git layout import — A → B without factory reset.
 */

import Database from "better-sqlite3"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  applyDeployGitBundle,
  parseDeployGitBundleFromDir,
} from "../src/features/platform/application/import-deploy-git-artifacts.js"
import { writeDeployGitExport } from "../src/features/platform/application/export-deploy-git-artifacts.js"
import { ensureSyncDefinitionConfigs } from "../src/features/sync/application/definitions.js"
import * as db from "../src/platform/persistence/db/index.js"

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

  for (const name of ["sync-metadata.json", "strategies.json", "flow-templates.json"]) {
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
  dataDir = mkdtempSync(join(tmpdir(), "deploy-git-import-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "deploy-git-import-root-"))
  seedRepoArtifacts(projectRoot)

  const { seedSyncMetadataIfEmpty } = await import(
    "../src/features/sync/application/seed-sync-metadata.js"
  )
  seedSyncMetadataIfEmpty(projectRoot)
}

describe("deploy git layout import", () => {
  beforeEach(async () => {
    await setupDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("imports exported deploy git bundle into an empty entity registry", async () => {
    expect(db.listEntityDefinitions("_default").length).toBe(0)

    const { seedEntityRegistryIfEmpty } = await import(
      "../src/features/sync/application/seed-entity-registry.js"
    )
    seedEntityRegistryIfEmpty(projectRoot)
    ensureSyncDefinitionConfigs(projectRoot)

    const parent = mkdtempSync(join(tmpdir(), "deploy-git-roundtrip-"))
    try {
      const exported = writeDeployGitExport({
        outputParentDir: parent,
        projectRoot,
        tenantId: "_default",
      })
      const bundle = parseDeployGitBundleFromDir(exported.folderPath)

      for (const row of db.listEntityDefinitions("_default")) {
        db.retireEntityDefinition("_default", row.id, "test")
      }
      expect(db.listEntityDefinitions("_default").length).toBe(0)

      const applied = applyDeployGitBundle({
        bundle,
        actor: "test",
        projectRoot,
        dryRun: false,
      })
      expect(applied.applied).toBe(true)
      expect(db.getEntityDefinition("_default", "dataset")).toBeTruthy()
      expect(db.getSyncDefinitionConfig("_default", "dataset")?.flow_preset).toBeTruthy()
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
