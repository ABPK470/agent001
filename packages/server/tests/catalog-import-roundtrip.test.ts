/**
 * Catalog import/export round-trip — run bindings, metadataOnly, version rollback.
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
} from "../src/features/platform/application/import-deploy-artifacts.js"
import {
  buildDeployCatalogSnapshot,
  writeDeployCatalogSnapshot,
} from "../src/features/platform/application/export-deploy-artifacts.js"
import {
  commitSyncCatalogVersion,
  rollbackSyncCatalogVersion,
} from "../src/features/platform/application/sync-catalog-versioning.js"
import { publishSyncDefinitionsFromDb } from "../src/features/sync/application/definitions.js"
import {
  ensureSyncDefinitionConfigs,
  listSyncDefinitionAdminItems,
  loadAuthoringFlowCatalog,
} from "../src/features/sync/application/definitions.js"
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
  dataDir = mkdtempSync(join(tmpdir(), "catalog-import-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "catalog-import-root-"))
  seedRepoArtifacts(projectRoot)

  const { seedEntityRegistryIfEmpty } = await import(
    "../src/features/sync/application/seed-entity-registry.js"
  )
  const { seedSyncMetadataIfEmpty } = await import(
    "../src/features/sync/application/seed-sync-metadata.js"
  )
  seedEntityRegistryIfEmpty(projectRoot)
  seedSyncMetadataIfEmpty(projectRoot)
  ensureSyncDefinitionConfigs(projectRoot)
}

describe("catalog import/export round-trip", () => {
  beforeEach(async () => {
    await setupDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("exports and re-imports sync definition configs with run bindings", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: "_default" })
    expect(snapshot.syncDefinitionConfigs?.configs.length).toBeGreaterThan(0)

    const datasetConfig = snapshot.syncDefinitionConfigs?.configs.find((row) => row.entityId === "dataset")
    expect(datasetConfig?.flowPreset).toBeTruthy()

    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(true)

    for (const row of db.listSyncDefinitionConfigs("_default")) {
      db.deleteSyncDefinitionConfig("_default", row.entity_id)
    }

    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "test",
      projectRoot,
      dryRun: false,
    })
    expect(applied.ok).toBe(true)
    expect(applied.applied).toBe(true)

    const restored = db.getSyncDefinitionConfig("_default", "dataset")
    expect(restored?.flow_preset).toBe(datasetConfig?.flowPreset)

    const adminItems = listSyncDefinitionAdminItems(projectRoot)
    const datasetItem = adminItems.find((item) => item.id === "dataset")
    expect(datasetItem?.flowTemplateId).toBe(datasetConfig?.flowPreset)
    expect(datasetItem?.executionSteps.length).toBeGreaterThan(0)
  })

  it("resolves metadataOnly even when DB presets omit it", () => {
    for (const preset of db.listSyncRunPresets("_default")) {
      if (preset.id === "metadataOnly") {
        db.deleteSyncRunPreset("_default", preset.id)
      }
    }

    const catalog = loadAuthoringFlowCatalog(projectRoot, "_default")
    expect("metadataOnly" in catalog.flowTemplates).toBe(true)
    expect("dataset" in catalog.flowTemplates).toBe(true)

    db.saveSyncDefinitionConfig({
      tenant_id: "_default",
      entity_id: "dataset",
      flow_preset: "metadataOnly",
      execution_steps_json: "[]",
      service_profile_ref: "default",
      environment_policy_ref: "default",
      ownership_team: "sync-platform",
      ownership_owner: null,
      review_status: "legacy-review-required",
      ownership_notes_json: JSON.stringify(["test"]),
      updated_at: new Date().toISOString(),
      updated_by: "test",
    })

    const items = listSyncDefinitionAdminItems(projectRoot)
    const dataset = items.find((item) => item.id === "dataset")
    expect(dataset?.flowTemplateId).toBe("metadataOnly")
    expect(dataset?.executionSteps.length).toBeGreaterThan(0)
  })

  it("rejects snapshots that reference unknown flows", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: "_default" })
    snapshot.syncDefinitionConfigs = {
      version: 1,
      _comment: "test",
      configs: [
        {
          entityId: "dataset",
          flowPreset: "does-not-exist",
          serviceProfileRef: "default",
          environmentPolicyRef: "default",
          ownershipTeam: "sync-platform",
          ownershipOwner: null,
          reviewStatus: "legacy-review-required",
          ownershipNotes: [],
        },
      ],
    }

    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(false)
    expect(preview.errors.some((error) => error.includes("does-not-exist"))).toBe(true)
  })

  it("writes sync-definition-configs.json into export folders", () => {
    const parent = mkdtempSync(join(tmpdir(), "catalog-export-dir-"))
    const result = writeDeployCatalogSnapshot({
      outputParentDir: parent,
      tenantId: "_default",
    })
    expect(result.files).toContain("sync-definition-configs.json")
    rmSync(parent, { recursive: true, force: true })
  })

  it("catalog import retires active entities missing from the snapshot", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: "_default" })
    const template = db.getEntityDefinition("_default", "contract")
    expect(template).toBeTruthy()

    db.saveEntityDefinition({
      tenantId: "_default",
      actor: "test",
      reason: "test-add",
      def: {
        ...template!,
        id: "restoreOrphanTest",
        displayName: "Restore Orphan Test",
      },
    })
    expect(db.getEntityDefinition("_default", "restoreOrphanTest")).toBeTruthy()

    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "test",
      projectRoot,
      dryRun: false,
    })
    expect(applied.applied).toBe(true)
    expect(db.getEntityDefinition("_default", "restoreOrphanTest")).toBeNull()
    expect(
      db.getEntityDefinition("_default", "restoreOrphanTest", { includeRetired: true })?.retiredAt,
    ).toBeTruthy()
    expect(db.getEntityDefinition("_default", "contract")).toBeTruthy()
  })

  it("catalog rollback still publishes core entities with metadataSync", () => {
    const baseline = commitSyncCatalogVersion({ reason: "test-baseline", actor: "test" })
    commitSyncCatalogVersion({ reason: "test-follow-up", actor: "test" })

    rollbackSyncCatalogVersion({
      targetVersion: baseline.version,
      actor: "test",
      projectRoot,
    })

    const result = publishSyncDefinitionsFromDb(projectRoot)
    for (const entityId of ["content", "contract", "dataset"]) {
      expect(result.stderr.some((line) => line.includes(`Refusing to publish "${entityId}"`))).toBe(false)
    }
  })

  it("loadAuthoringFlowCatalog falls back to shipped steps when a DB preset is empty", async () => {
    const { loadAuthoringFlowCatalog } = await import("../src/features/sync/application/definitions.js")
    db.saveSyncRunPreset({
      tenant_id: "_default",
      id: "content",
      label: "Broken content",
      description: "empty steps in db",
      steps_json: "[]",
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "test",
    })

    const catalog = loadAuthoringFlowCatalog(projectRoot, "_default")
    expect(catalog.flowTemplates.content.steps.some((step) => step.kind === "metadataSync")).toBe(true)

    const result = publishSyncDefinitionsFromDb(projectRoot)
    expect(result.stderr.some((line) => line.includes('Refusing to publish "content"'))).toBe(false)
  })

  it("publish accepts legacy kebab-case metadata-sync step kinds from stored presets", () => {
    db.saveSyncRunPreset({
      tenant_id: "_default",
      id: "content",
      label: "Legacy content",
      description: "kebab-case kinds",
      steps_json: JSON.stringify([
        {
          id: "metadata-sync",
          phase: "metadata",
          kind: "metadata-sync",
          title: "Metadata sync",
          description: "Apply metadata",
        },
      ]),
      built_in: 1,
      updated_at: new Date().toISOString(),
      updated_by: "test",
    })

    const result = publishSyncDefinitionsFromDb(projectRoot)
    expect(result.stderr.some((line) => line.includes('Refusing to publish "content"'))).toBe(false)
    expect(result.definitionCount).toBeGreaterThan(0)
  })

  it("catalog rollback retires entities added after the restored version", () => {
    const baseline = commitSyncCatalogVersion({ reason: "test-baseline", actor: "test" })
    const template = db.getEntityDefinition("_default", "contract")
    expect(template).toBeTruthy()

    db.saveEntityDefinition({
      tenantId: "_default",
      actor: "test",
      reason: "test-add",
      def: {
        ...template!,
        id: "rollbackOrphanTest",
        displayName: "Rollback Orphan Test",
      },
    })
    commitSyncCatalogVersion({ reason: "test-with-orphan", actor: "test" })
    expect(db.getEntityDefinition("_default", "rollbackOrphanTest")).toBeTruthy()

    rollbackSyncCatalogVersion({
      targetVersion: baseline.version,
      actor: "test",
      projectRoot,
    })

    expect(db.getEntityDefinition("_default", "rollbackOrphanTest")).toBeNull()
    expect(db.getEntityDefinition("_default", "contract")).toBeTruthy()
  })
})
