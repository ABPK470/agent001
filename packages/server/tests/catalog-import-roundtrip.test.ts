/**
 * Catalog import/export round-trip — run bindings, metadataOnly, version rollback.
 */

import Database from "better-sqlite3"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  applyDeployCatalogSnapshot,
  parseCatalogBundleFromDir,
  validateDeployCatalogSnapshot,
} from "../src/api/platform/service/import-deploy-artifacts.js"
import {
  buildDeployCatalogSnapshot,
  writeDeployCatalogSnapshot,
} from "../src/api/platform/service/export-deploy-artifacts.js"
import {
  commitSyncCatalogVersion,
  rollbackSyncCatalogVersion,
} from "../src/api/platform/service/sync-catalog-versioning.js"
import { publishSyncDefinitionsFromDb } from "../src/api/sync/service/definitions.js"
import {
  ensureSyncDefinitionConfigs,
  listSyncDefinitionAdminItems,
  loadAuthoringFlowCatalog,
} from "../src/api/sync/service/definitions.js"
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

  const envSource = join(repoDeploySync, "sync-environments.json")
  if (existsSync(envSource)) {
    copyFileSync(envSource, join(targetDeploySync, "sync-environments.json"))
  }
}

async function setupDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), "catalog-import-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "catalog-import-root-"))
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

describe("catalog import/export round-trip", () => {
  beforeEach(async () => {
    await setupDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("exports and re-imports entity flowId", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: "_default" })
    expect(snapshot.syncDefinitionConfigs).toBeNull()

    const datasetEntry = snapshot.entityRegistry?.entities.find(
      (entry) => (entry as { id?: string }).id === "dataset",
    ) as { flowId?: string } | undefined
    expect(datasetEntry?.flowId).toBeTruthy()
    const flowPreset = datasetEntry!.flowId!

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
    expect(restored?.flow_preset).toBe(flowPreset)

    const adminItems = listSyncDefinitionAdminItems(projectRoot)
    const datasetItem = adminItems.find((item) => item.id === "dataset")
    expect(datasetItem?.flowTemplateId).toBe(flowPreset)
    expect(datasetItem?.executionSteps.length).toBeGreaterThan(0)
  })

  it("resolves metadataOnly even when DB presets omit it", () => {
    for (const preset of db.listSyncFlows("_default")) {
      if (preset.id === "metadataOnly") {
        db.deleteSyncFlow("_default", preset.id)
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
    const datasetEntry = snapshot.entityRegistry?.entities.find(
      (entry) => (entry as { id?: string }).id === "dataset",
    ) as { flowId?: string } | undefined
    expect(datasetEntry?.flowId).toBeTruthy()
    datasetEntry!.flowId = "does-not-exist"

    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(false)
    expect(preview.errors.some((error) => error.includes("does-not-exist"))).toBe(true)
  })

  it("writes deploy/sync tree (entities/*.json), not bulk entity-registry", () => {
    const parent = mkdtempSync(join(tmpdir(), "catalog-export-dir-"))
    const result = writeDeployCatalogSnapshot({
      outputParentDir: parent,
      tenantId: "_default",
    })
    expect(result.files).toContain("entities/dataset.json")
    expect(result.files).not.toContain("entity-registry.json")
    expect(result.files).not.toContain("sync-definition-configs.json")
    const entityPath = join(result.folderPath, "artifacts", "entities", "dataset.json")
    const doc = JSON.parse(readFileSync(entityPath, "utf-8")) as { id: string; flowId: string }
    expect(doc.id).toBe("dataset")
    expect(doc.flowId).toBeTruthy()

    const loaded = parseCatalogBundleFromDir(result.folderPath)
    const dataset = loaded.entityRegistry?.entities.find(
      (entry) => (entry as { id?: string }).id === "dataset",
    ) as { flowId?: string } | undefined
    expect(dataset?.flowId).toBe(doc.flowId)

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
    const { loadAuthoringFlowCatalog } = await import("../src/api/sync/service/definitions.js")
    db.saveSyncFlow({
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

  it("rejects catalog snapshots with kebab-case flow step kinds", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: "_default" })
    const meta = snapshot.syncMetadata as {
      flows?: Record<string, { label: string; description?: string; steps: unknown[] }>
    }
    const contentFlow = meta.flows?.content
    expect(contentFlow).toBeTruthy()
    contentFlow!.steps = [
      {
        id: "metadata-sync",
        phase: "metadata",
        kind: "metadata-sync",
        title: "Metadata sync",
        description: "Apply metadata",
      },
    ]

    const preview = validateDeployCatalogSnapshot(snapshot)
    expect(preview.ok).toBe(false)
    expect(preview.errors.some((error) => error.includes("camelCase"))).toBe(true)
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
