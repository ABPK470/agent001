/**
 * Deploy artifact import — A → B per entity.
 */

import Database from "better-sqlite3"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { importAuthoredSyncFromText } from "../src/api/sync/application/import-authored-sync.js"
import { formatAuthoredSyncJson } from "../src/api/sync/domain/authored-sync-document.js"
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

async function setupEmptyDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), "artifact-import-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "artifact-import-root-"))
  seedRepoArtifacts(projectRoot)

  const { seedSyncMetadataIfEmpty } = await import(
    "../src/api/sync/application/seed-sync-metadata.js"
  )
  seedSyncMetadataIfEmpty(projectRoot)
}

describe("deploy artifact import (A → B)", () => {
  beforeEach(async () => {
    await setupEmptyDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("imports dataset.json into entity registry with sync config", () => {
    const seedPath = resolve(projectRoot, "deploy/sync/artifacts/entities/dataset.json")
    const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as AuthoredSyncDefinition

    const preview = importAuthoredSyncFromText({
      tenantId: "_default",
      actor: "test",
      reason: "preview",
      content: formatAuthoredSyncJson(seed),
      projectRoot,
      dryRun: true,
    })
    expect(preview.ok).toBe(true)
    expect(preview.saved).toHaveLength(1)
    expect(preview.saved[0]?.created).toBe(true)

    const applied = importAuthoredSyncFromText({
      tenantId: "_default",
      actor: "test",
      reason: "apply",
      content: formatAuthoredSyncJson(seed),
      projectRoot,
      dryRun: false,
    })
    expect(applied.ok).toBe(true)

    const entity = db.getEntityDefinition("_default", "dataset")
    expect(entity?.rootTable).toBe(seed.rootTable)
    expect(entity?.tables.length).toBe(seed.metadata.tables.length)

    const config = db.getSyncDefinitionConfig("_default", "dataset")
    expect(config?.service_profile_ref).toBe(seed.bindings.serviceProfileRef)
    expect(config?.environment_policy_ref).toBe(seed.bindings.environmentPolicyRef)
    expect(config?.flow_preset).toBeTruthy()
  })

  it("updates an existing entity when re-importing artifact", () => {
    const seedPath = resolve(projectRoot, "deploy/sync/artifacts/entities/dataset.json")
    const seed = JSON.parse(readFileSync(seedPath, "utf-8")) as AuthoredSyncDefinition
    const content = formatAuthoredSyncJson(seed)

    importAuthoredSyncFromText({
      tenantId: "_default",
      actor: "test",
      reason: "first",
      content,
      projectRoot,
      dryRun: false,
    })

    const updated = { ...seed, description: "Updated via artifact re-import" }
    const second = importAuthoredSyncFromText({
      tenantId: "_default",
      actor: "test",
      reason: "second",
      content: formatAuthoredSyncJson(updated),
      projectRoot,
      dryRun: false,
    })
    expect(second.ok).toBe(true)
    expect(second.saved[0]?.created).toBe(false)
    expect(db.getEntityDefinition("_default", "dataset")?.description).toBe(updated.description)
  })

  it("rejects invalid artifact JSON", () => {
    const result = importAuthoredSyncFromText({
      tenantId: "_default",
      actor: "test",
      reason: "bad",
      content: JSON.stringify({ id: "broken" }),
      projectRoot,
      dryRun: true,
    })
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})
