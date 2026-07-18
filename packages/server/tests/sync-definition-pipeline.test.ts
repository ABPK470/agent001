/**
 * End-to-end sync definition pipeline: entity registry → publish → runtime load.
 */

import Database from "better-sqlite3"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AgentHost } from "@mia/agent"
import {
  compileFkPathPredicate,
  compilePublishedSyncDefinition,
  createDbPublishedSyncDefinitionRegistry,
  loadSyncDefinitionFlowTemplateCatalog,
  scaffoldSyncDefinition,
  type EntityDefinition
} from "@mia/sync"
import { loadPublishedBundleFromSqlite } from "../src/boot/published-sync-bundle.js"

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

function createHost(root: string): AgentHost {
  return {
    mssql: { databases: new Map(), defaultConnection: { value: "DEV" } },
    sync: {
      events: { sink: () => {} },
      runs: {
        sink: { start: () => {}, finish: () => {}, savePlan: () => {}, loadPlan: () => null },
        actorUpn: null
      },
      governance: { freezeWindowsReader: () => [] },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: root,
        publishedDefinitions: createDbPublishedSyncDefinitionRegistry(loadPublishedBundleFromSqlite),
      }
    }
  } as unknown as AgentHost
}

function makeFkPathEntity(id: string): EntityDefinition {
  return {
    tenantId: "_default",
    id,
    displayName: "FK Path Entity",
    description: "Pipeline integration fixture",
    rootTable: "core.Parent",
    idColumn: "parentId",
    labelColumn: "name",
    selfJoinColumn: null,
    tables: [
      {
        name: "core.Parent",
        scope: { kind: "rootPk", column: "parentId" },
        executionOrder: 0,
        scd2Override: null,
        verified: true,
        scopeColumn: "parentId",
        source: "manual",
        groundedByPipeline: false,
        enabledByDefault: true,
        userControllable: false,
        archiveTable: null,
        note: null,
        provenance: { kind: "manual" }
      },
      {
        name: "core.Child",
        scope: {
          kind: "sql",
          predicate: compileFkPathPredicate({ selfJoinColumn: null }, "core.Child", [
            { table: "core.Child", fromColumn: "parentId", toColumn: "childId" }
          ])
        },
        executionOrder: 1,
        scd2Override: null,
        verified: true,
        scopeColumn: null,
        source: "fk-only",
        groundedByPipeline: false,
        enabledByDefault: false,
        userControllable: true,
        archiveTable: null,
        note: null,
        provenance: { kind: "manual" }
      }
    ],
    policies: { freezeWindowIds: [] },
    scd2: { strategyId: "mymi-scd2", strategyVersion: 1, entityOverride: null },
    lineageRefs: [],
    provenance: { kind: "manual" },
    legacyEntrySproc: null,
    reverseOrder: ["core.Child", "core.Parent"],
    discrepancies: [],
    version: 1,
    versionLabel: null,
    createdBy: "test",
    reason: "seed",
    createdAt: new Date().toISOString(),
    retiredAt: null
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-sync-pipeline-data-"))
  projectRoot = mkdtempSync(join(tmpdir(), "mia-sync-pipeline-root-"))
  mkdirSync(join(projectRoot, "deploy", "sync", "artifacts"), { recursive: true })
  writeFileSync(
    join(projectRoot, "deploy", "sync", "artifacts", "flow-templates.json"),
    readFileSync(new URL("../../../deploy/sync/artifacts/flow-templates.json", import.meta.url), "utf-8")
  )
  writeFileSync(
    join(projectRoot, "deploy", "sync", "artifacts", "sync-metadata.json"),
    readFileSync(new URL("../../../deploy/sync/artifacts/sync-metadata.json", import.meta.url), "utf-8")
  )
  process.env["MIA_DATA_DIR"] = dataDir
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
})

afterEach(() => {
  testDb.close()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(projectRoot, { recursive: true, force: true })
  if (ORIGINAL_DATA_DIR === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = ORIGINAL_DATA_DIR
})

describe("sync definition pipeline (e2e)", () => {
  it("artifact seed -> entity registry -> publish preserves the contract DatasetMappingColumn predicate", async () => {
    const { _setDb, _migrate } = await import("../src/infra/persistence/db/index.js")
    const { seedEntityRegistryIfEmpty } =
      await import("../src/api/sync/service/seed-entity-registry.js")
    const { publishSyncDefinitionsFromDb } = await import("../src/api/sync/service/definitions.js")
    const { seedSyncMetadataIfEmpty } = await import("../src/api/sync/service/seed-sync-metadata.js")

    _setDb(testDb)
    _migrate(testDb)

    const repoArtifactsDir = resolve(import.meta.dirname, "../../../deploy/sync/artifacts/entities")
    const repoArtifactsParent = resolve(import.meta.dirname, "../../../deploy/sync/artifacts")
    const tempArtifactsDir = join(projectRoot, "deploy", "sync", "artifacts", "entities")
    mkdirSync(tempArtifactsDir, { recursive: true })
    for (const file of readdirSync(repoArtifactsDir).filter((name) => name.endsWith(".json"))) {
      copyFileSync(join(repoArtifactsDir, file), join(tempArtifactsDir, file))
    }
    for (const name of ["sync-metadata.json", "flow-templates.json", "strategies.json"]) {
      const source = join(repoArtifactsParent, name)
      if (existsSync(source)) {
        copyFileSync(source, join(projectRoot, "deploy", "sync", "artifacts", name))
      }
    }

    const seedResult = seedEntityRegistryIfEmpty(projectRoot)
    expect(seedResult.source).toBe("artifacts")
    expect(seedResult.entityIds).toContain("contract")

    seedSyncMetadataIfEmpty(projectRoot)
    const published = publishSyncDefinitionsFromDb(projectRoot)
    expect(published.publishedStorage).toBe("sqlite")

    const { loadPublishedBundleFromDb } = await import("../src/infra/persistence/db/index.js")
    const bundle = loadPublishedBundleFromDb()
    expect(bundle).toBeTruthy()

    const table = (
      bundle!.definitions.contract as {
        metadata: { tables: Array<{ name: string; predicate: string }> }
      }
    ).metadata.tables.find((t) => t.name === "core.DatasetMappingColumn")
    expect(table?.predicate).toContain("[core].[DatasetMappingColumn].[datasetMappingId]")
    expect(table?.predicate).toContain("FROM core.DatasetMapping")
    expect(table?.predicate).toContain("FROM core.Dataset WHERE contractId = {id}")
    expect(table?.predicate).not.toContain("datasetColumnId_Left")
  })

  it("publish preserves multi-hop sql predicates matching scaffold output", async () => {
    const { _setDb, _migrate, saveEntityDefinition } = await import("../src/infra/persistence/db/index.js")
    const { publishSyncDefinitionsFromDb } = await import("../src/api/sync/service/definitions.js")

    _setDb(testDb)
    _migrate(testDb)
    const { seedSyncMetadataIfEmpty } = await import("../src/api/sync/service/seed-sync-metadata.js")
    seedSyncMetadataIfEmpty(projectRoot)

    const entity = makeFkPathEntity("fk_path_entity")
    saveEntityDefinition({ tenantId: "_default", def: entity, actor: "test", reason: "seed" })

    const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const scaffolded = scaffoldSyncDefinition(entity, { projectRoot, flowTemplateCatalog })
    const childScaffoldPredicate = scaffolded.metadata.tables.find((t) => t.name === "core.Child")?.predicate

    publishSyncDefinitionsFromDb(projectRoot)
    publishSyncDefinitionsFromDb(projectRoot)

    const { loadPublishedBundleFromDb } = await import("../src/infra/persistence/db/index.js")
    const bundle = loadPublishedBundleFromDb()
    expect(bundle).toBeTruthy()

    const publishedChild = (
      bundle!.definitions.fk_path_entity as {
        metadata: { tables: Array<{ name: string; predicate: string }> }
      }
    ).metadata.tables.find((t) => t.name === "core.Child")
    expect(publishedChild?.predicate).toBe(childScaffoldPredicate)
    expect(publishedChild?.predicate).toContain("EXISTS")
  })

  it("published custom entity is loadable at runtime with predicates intact", async () => {
    const { _setDb, _migrate, saveEntityDefinition } = await import("../src/infra/persistence/db/index.js")
    const { publishSyncDefinitionsFromDb } = await import("../src/api/sync/service/definitions.js")
    const { listPublishedSyncDefinitions } = await import("@mia/sync")

    _setDb(testDb)
    _migrate(testDb)
    const { seedSyncMetadataIfEmpty } = await import("../src/api/sync/service/seed-sync-metadata.js")
    seedSyncMetadataIfEmpty(projectRoot)

    const entity = makeFkPathEntity("custom_runtime_entity")
    saveEntityDefinition({ tenantId: "_default", def: entity, actor: "test", reason: "seed" })
    publishSyncDefinitionsFromDb(projectRoot)

    const host = createHost(projectRoot)
    const published = listPublishedSyncDefinitions(host, projectRoot)
    expect(published.map((d) => d.id)).toContain("custom_runtime_entity")

    const definition = published.find((d) => d.id === "custom_runtime_entity")!
    expect(definition.id).toBe("custom_runtime_entity")
    expect(definition.metadata.tables.some((t) => t.predicate.includes("EXISTS"))).toBe(true)
  })

  it("compilePublishedSyncDefinition matches server publish output for same entity", async () => {
    const { _setDb, _migrate, saveEntityDefinition, listSyncDefinitionConfigs } =
      await import("../src/infra/persistence/db/index.js")
    const {
      publishSyncDefinitionsFromDb,
      ensureSyncDefinitionConfigs,
      loadAuthoringFlowCatalog,
    } = await import("../src/api/sync/service/definitions.js")

    _setDb(testDb)
    _migrate(testDb)
    const { seedSyncMetadataIfEmpty } = await import("../src/api/sync/service/seed-sync-metadata.js")
    seedSyncMetadataIfEmpty(projectRoot)

    const entity = makeFkPathEntity("compose_parity")
    saveEntityDefinition({ tenantId: "_default", def: entity, actor: "test", reason: "seed" })
    ensureSyncDefinitionConfigs(projectRoot)
    const config = listSyncDefinitionConfigs("_default").find((row) => row.entity_id === "compose_parity")!

    const { buildFlowCatalog, compilePublishedSyncDefinition } = await import("@mia/sync")
    const db = await import("../src/infra/persistence/db/index.js")
    // Must use the same authoring catalog as publish: DB presets strip `phase`
    // from stored steps, so snapForSteps only freezes kinds (phases stay {}).
    // File-template catalogs still carry phase and would diverge.
    const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot)
    const flowCatalog = buildFlowCatalog(
      db.listSyncPhases("_default"),
      db.listSyncActions("_default"),
      db.listSyncValueSources("_default"),
    )

    const direct = compilePublishedSyncDefinition(
      entity,
      config,
      flowTemplateCatalog,
      flowCatalog,
      "2026-06-01T00:00:00.000Z",
      "direct",
      (strategyId) => db.resolveScd2Strategy("_default", strategyId) ?? null,
    )

    publishSyncDefinitionsFromDb(projectRoot)
    publishSyncDefinitionsFromDb(projectRoot)

    const { loadPublishedBundleFromDb } = await import("../src/infra/persistence/db/index.js")
    const bundle = loadPublishedBundleFromDb()
    expect(bundle).toBeTruthy()

    const published = bundle!.definitions.compose_parity as {
      metadata: { tables: Array<{ name: string; predicate: string }> }
      executionFlow: { catalog?: { phases: Record<string, unknown>; kinds: Record<string, unknown> } }
    }
    expect(published?.metadata.tables.map((t) => [t.name, t.predicate])).toEqual(
      direct.metadata.tables.map((t) => [t.name, t.predicate])
    )
    expect(published?.executionFlow.catalog).toEqual(direct.executionFlow.catalog)
    expect(published?.executionFlow.catalog?.kinds).toBeDefined()
  })
})
