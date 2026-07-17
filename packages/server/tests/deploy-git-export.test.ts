/**
 * Bulk deploy git layout export — B → A for all entities.
 */

import Database from "better-sqlite3"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { writeDeployGitExport } from "../src/api/platform/service/export-deploy-git-artifacts.js"
import { ensureSyncDefinitionConfigs } from "../src/api/sync/service/definitions.js"
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

  for (const name of ["sync-metadata.json", "strategies.json", "flow-templates.json"]) {
    const source = join(repoDeploySync, "artifacts", name)
    if (existsSync(source)) {
      copyFileSync(source, join(targetDeploySync, "artifacts", name))
    }
  }
}

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), "deploy-git-export-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "deploy-git-export-root-"))
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

describe("deploy git layout export", () => {
  beforeEach(async () => {
    await setupDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("writes artifacts/entities/*.json and platform metadata files", () => {
    const parent = mkdtempSync(join(tmpdir(), "deploy-git-export-dir-"))
    try {
      const result = writeDeployGitExport({
        outputParentDir: parent,
        projectRoot,
        tenantId: "_default",
      })

      expect(result.entityIds.length).toBeGreaterThan(0)
      expect(result.files).toContain("sync-metadata.json")
      expect(result.files).toContain("strategies.json")
      expect(result.files).toContain("flow-templates.json")
      expect(result.files.some((file) => file.startsWith("artifacts/entities/"))).toBe(true)

      const datasetPath = join(result.folderPath, "artifacts", "entities", "dataset.json")
      expect(existsSync(datasetPath)).toBe(true)
      const exported = JSON.parse(readFileSync(datasetPath, "utf-8")) as AuthoredSyncDefinition
      expect(exported.id).toBe("dataset")
      expect(exported.metadata.tables.length).toBeGreaterThan(0)
      expect(existsSync(join(result.folderPath, "artifacts", "sync-metadata.json"))).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
