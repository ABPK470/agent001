/**
 * End-to-end sync definition pipeline: entity registry → publish → runtime load.
 */

import Database from "better-sqlite3"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AgentHost } from "@mia/agent"
import {
  composePublishedSyncDefinition,
  createPublishedSyncDefinitionRegistry,
  definitionToSyncRecipe,
  loadSyncDefinitionFlowTemplateCatalog,
  scaffoldSyncDefinition,
  type EntityDefinition
} from "@mia/sync"

let testDb: Database.Database
let dataDir: string
let projectRoot: string
const ORIGINAL_DATA_DIR = process.env["MIA_DATA_DIR"]

function createHost(root: string): AgentHost {
  return {
    mssql: { databases: new Map(), defaultConnection: { value: "DEV" } },
    sync: {
      events: { sink: () => {} },
      runs: { sink: { start: () => {}, finish: () => {}, savePlan: () => {}, loadPlan: () => null }, actorUpn: null },
      governance: { freezeWindowsReader: () => [] },
      environments: { items: new Map() },
      plans: { diskRoot: null, memCache: new Map() },
      project: { dbProjectRoot: root, publishedDefinitions: createPublishedSyncDefinitionRegistry() }
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
          kind: "fkPath",
          through: [{ table: "core.Child", fromColumn: "parentId", toColumn: "childId" }]
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
    policies: { freezeWindowIds: [], riskMultiplier: 1 },
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
  mkdirSync(join(projectRoot, "sync-definitions", "published"), { recursive: true })
  writeFileSync(
    join(projectRoot, "deploy", "sync", "artifacts", "flow-templates.json"),
    readFileSync(new URL("../../../deploy/sync/artifacts/flow-templates.json", import.meta.url), "utf-8")
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
  it("publish preserves fkPath predicates matching scaffold output", async () => {
    const { _setDb, _migrate, saveEntityDefinition } = await import(
      "../src/platform/persistence/db/index.js"
    )
    const { publishSyncDefinitionsFromDb } = await import(
      "../src/features/sync/application/definitions.js"
    )

    _setDb(testDb)
    _migrate(testDb)

    const entity = makeFkPathEntity("fk_path_entity")
    saveEntityDefinition({ tenantId: "_default", def: entity, actor: "test", reason: "seed" })

    const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const scaffolded = scaffoldSyncDefinition(entity, { projectRoot, flowTemplateCatalog })
    const childScaffoldPredicate = scaffolded.metadata.tables.find((t) => t.name === "core.Child")?.predicate

    publishSyncDefinitionsFromDb(projectRoot)

    const bundle = JSON.parse(
      readFileSync(join(projectRoot, "sync-definitions", "published", "definitions.bundle.json"), "utf-8")
    ) as { definitions: Record<string, { metadata: { tables: Array<{ name: string; predicate: string }> } }> }

    const publishedChild = bundle.definitions.fk_path_entity?.metadata.tables.find(
      (t) => t.name === "core.Child"
    )
    expect(publishedChild?.predicate).toBe(childScaffoldPredicate)
    expect(publishedChild?.predicate).toContain("EXISTS")
  })

  it("published custom entity is loadable at runtime and projects to recipe", async () => {
    const { _setDb, _migrate, saveEntityDefinition } = await import(
      "../src/platform/persistence/db/index.js"
    )
    const { publishSyncDefinitionsFromDb } = await import(
      "../src/features/sync/application/definitions.js"
    )
    const { listPublishedSyncDefinitions } = await import("@mia/sync")

    _setDb(testDb)
    _migrate(testDb)

    const entity = makeFkPathEntity("custom_runtime_entity")
    saveEntityDefinition({ tenantId: "_default", def: entity, actor: "test", reason: "seed" })
    publishSyncDefinitionsFromDb(projectRoot)

    const host = createHost(projectRoot)
    const published = listPublishedSyncDefinitions(host, projectRoot)
    expect(published.map((d) => d.id)).toContain("custom_runtime_entity")

    const recipe = definitionToSyncRecipe(published.find((d) => d.id === "custom_runtime_entity")!)
    expect(recipe.entityType).toBe("custom_runtime_entity")
    expect(recipe.tables.some((t) => t.predicate.includes("EXISTS"))).toBe(true)
  })

  it("composePublishedSyncDefinition matches server publish output for same entity", async () => {
    const { _setDb, _migrate, saveEntityDefinition, listSyncDefinitionConfigs } = await import(
      "../src/platform/persistence/db/index.js"
    )
    const { publishSyncDefinitionsFromDb, ensureSyncDefinitionConfigs } = await import(
      "../src/features/sync/application/definitions.js"
    )

    _setDb(testDb)
    _migrate(testDb)

    const entity = makeFkPathEntity("compose_parity")
    saveEntityDefinition({ tenantId: "_default", def: entity, actor: "test", reason: "seed" })
    ensureSyncDefinitionConfigs(projectRoot)
    const config = listSyncDefinitionConfigs("_default").find((row) => row.entity_id === "compose_parity")!

    const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
    const direct = composePublishedSyncDefinition(
      entity,
      config,
      flowTemplateCatalog,
      "2026-06-01T00:00:00.000Z",
      "direct"
    )

    publishSyncDefinitionsFromDb(projectRoot)
    const bundle = JSON.parse(
      readFileSync(join(projectRoot, "sync-definitions", "published", "definitions.bundle.json"), "utf-8")
    ) as { definitions: Record<string, { metadata: { tables: Array<{ name: string; predicate: string }> } }> }

    const published = bundle.definitions.compose_parity
    expect(published?.metadata.tables.map((t) => [t.name, t.predicate])).toEqual(
      direct.metadata.tables.map((t) => [t.name, t.predicate])
    )
  })
})
