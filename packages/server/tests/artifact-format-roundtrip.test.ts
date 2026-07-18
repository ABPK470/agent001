/**
 * Integration tests — Catalog snapshot + Authored compat conversion round-trips.
 */

import Database from "better-sqlite3"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"
import { entityDefinitionFromAuthoredSync, loadSyncDefinitionFlowTemplateCatalog, validateEntityDefinition } from "@mia/sync"

import {
  applyDeployCatalogSnapshot,
  validateDeployCatalogSnapshot,
} from "../src/api/platform/service/import-deploy-artifacts.js"
import { buildDeployCatalogSnapshot } from "../src/api/platform/service/export-deploy-artifacts.js"
import { ensureSyncDefinitionConfigs } from "../src/api/sync/service/definitions.js"
import { importAuthoredSyncFromText, importOneAuthoredSync } from "../src/api/sync/service/import-authored-sync.js"
import {
  entityToAuthoredSyncDefinition,
  formatAuthoredSyncJson,
  syncConfigInputFromDb,
} from "../src/api/sync/types/authored-sync-document.js"
import { formatEntityJson, parseEntitiesJson } from "../src/api/sync/types/entity-yaml.js"
import * as db from "../src/infra/persistence/db/index.js"

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

const G1_AUTHORED = resolve(
  fileURLToPath(
    new URL(
      "../../../packages/sync/src/test-support/__goldens__/legacy-refresh/g1-authored-historical.json",
      import.meta.url,
    ),
  ),
)

function loadG1Authored(): Record<string, AuthoredSyncDefinition> {
  const g1 = JSON.parse(readFileSync(G1_AUTHORED, "utf-8")) as {
    entities: Record<string, AuthoredSyncDefinition>
  }
  return g1.entities
}

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

async function setupSeededDb(): Promise<void> {
  dataDir = mkdtempSync(join(tmpdir(), "artifact-roundtrip-test-"))
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
  _setDb(testDb)
  _migrate(testDb)

  projectRoot = mkdtempSync(join(tmpdir(), "artifact-roundtrip-root-"))
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

describe("artifact format round-trip integration", () => {
  beforeEach(async () => {
    await setupSeededDb()
  })

  afterEach(() => {
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true })
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
    process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
  })

  it("historical Authored → EntityDefinition → Authored preserves core entity semantics for dataset", () => {
    const seed = loadG1Authored().dataset
    expect(seed).toBeTruthy()

    const entityB = entityDefinitionFromAuthoredSync(seed!)
    expect(validateEntityDefinition(entityB).ok).toBe(true)

    const catalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const config = syncConfigInputFromDb({
      tenant_id: "_default",
      entity_id: "dataset",
      flow_preset: "dataset",
      execution_steps_json: "[]",
      service_profile_ref: seed!.bindings.serviceProfileRef,
      environment_policy_ref: seed!.bindings.environmentPolicyRef,
      ownership_team: seed!.ownership.team,
      ownership_owner: seed!.ownership.owner,
      review_status: seed!.ownership.reviewStatus,
      ownership_notes_json: JSON.stringify(seed!.ownership.notes),
      updated_at: new Date().toISOString(),
      updated_by: "test",
    })

    const exportedA = entityToAuthoredSyncDefinition(entityB, catalog, config)
    expect(exportedA.id).toBe(seed!.id)
    expect(exportedA.rootTable).toBe(seed!.rootTable)
    expect(exportedA.metadata.tables.length).toBe(seed!.metadata.tables.length)
    expect(exportedA.metadata.tables.map((table) => table.name).sort()).toEqual(
      seed!.metadata.tables.map((table) => table.name).sort(),
    )
  })

  it("B → registry JSON → B preserves structured fields", () => {
    const entity = db.getEntityDefinition("_default", "contract")
    expect(entity).toBeTruthy()
    const config = db.getSyncDefinitionConfig("_default", "contract")
    const json = formatEntityJson(entity!, {
      template: config!.flow_preset,
      service: config!.service_profile_ref,
      environment: config!.environment_policy_ref,
    })
    const parsed = parseEntitiesJson(json)
    expect(parsed[0]?.ok).toBe(true)
    expect(parsed[0]?.def?.tables.length).toBe(entity!.tables.length)
    expect(parsed[0]?.run?.template).toBe(config!.flow_preset)
  })

  it("catalog snapshot B bulk export/import round-trip still works", () => {
    const snapshot = buildDeployCatalogSnapshot({ tenantId: "_default" })
    expect(validateDeployCatalogSnapshot(snapshot).ok).toBe(true)

    for (const row of db.listSyncDefinitionConfigs("_default")) {
      db.deleteSyncDefinitionConfig("_default", row.entity_id)
    }

    const applied = applyDeployCatalogSnapshot({
      snapshot,
      actor: "test",
      projectRoot,
      dryRun: false,
    })
    expect(applied.applied).toBe(true)
    expect(db.getSyncDefinitionConfig("_default", "dataset")?.flow_preset).toBeTruthy()
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

  it("per-entity Authored import (compat) then export round-trips through SQLite", () => {
    const seed = loadG1Authored().gateMetadata!
    importAuthoredSyncFromText({
      tenantId: "_default",
      actor: "test",
      reason: "roundtrip",
      content: formatAuthoredSyncJson(seed),
      projectRoot,
      dryRun: false,
    })

    const entity = db.getEntityDefinition("_default", "gateMetadata")
    const configRow = db.getSyncDefinitionConfig("_default", "gateMetadata")
    const catalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const exported = entityToAuthoredSyncDefinition(
      entity!,
      catalog,
      configRow ? syncConfigInputFromDb(configRow) : null,
    )

    expect(exported.id).toBe("gateMetadata")
    expect(exported.executionFlow.steps.length).toBeGreaterThan(0)
  })

  it("metadataOnly flow survives Authored import via step-kind inference", () => {
    const seed = loadG1Authored().dataset!
    const metadataOnly = {
      ...seed,
      executionFlow: { steps: [{ kind: "metadataSync" }] },
    }

    const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const result = importOneAuthoredSync({
      authored: metadataOnly as AuthoredSyncDefinition,
      tenantId: "_default",
      actor: "test",
      reason: "metadata-only",
      projectRoot,
      dryRun: false,
      flowTemplateCatalog,
    })
    expect(result.error).toBeUndefined()
    expect(db.getSyncDefinitionConfig("_default", "dataset")?.flow_preset).toBe("metadataOnly")
  })
})
