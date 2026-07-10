/**
 * Compiler parity + pipeline integration tests.
 *
 * Guards the entity-registry → definition compiler chain across
 * scaffold and publish (compile) paths.
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { EntityDefinition, EntityTable } from "@mia/sync"
import {
  bundledStrategyById,
  compilePublishedSyncDefinition,
  compileFkPathPredicate,
  loadSyncDefinitionFlowTemplateCatalog,
  projectTablePredicate,
  scaffoldSyncDefinition,
} from "@mia/sync"
import { loadDeployFlowCatalogForTests } from "./test-flow-catalog.js"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "../../../..")
const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(repoRoot)
const deployFlowCatalog = loadDeployFlowCatalogForTests(repoRoot)

const tempRoots: string[] = []

function tbl(over: Partial<EntityTable> & Pick<EntityTable, "name" | "scope" | "executionOrder">): EntityTable {
  return {
    scd2Override: null,
    verified: true,
    archiveTable: null,
    note: null,
    provenance: { kind: "manual" },
    scopeColumn: null,
    source: "manual",
    groundedByPipeline: false,
    enabledByDefault: true,
    userControllable: false,
    ...over
  }
}

function makeEntity(over: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    id: "testEntity",
    tenantId: "_default",
    displayName: "Test Entity",
    description: "Compiler parity fixture",
    rootTable: "core.TestRoot",
    idColumn: "testId",
    labelColumn: "name",
    selfJoinColumn: null,
    tables: [
      tbl({
        name: "core.TestRoot",
        executionOrder: 0,
        scope: { kind: "rootPk", column: "testId" },
        scopeColumn: "testId"
      })
    ],
    policies: { freezeWindowIds: [] },
    scd2: { strategyId: "mymi-scd2", strategyVersion: 1, entityOverride: null },
    lineageRefs: [],
    provenance: { kind: "manual" },
    legacyEntrySproc: null,
    reverseOrder: [],
    discrepancies: [],
    version: 1,
    versionLabel: null,
    createdBy: "test",
    reason: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    retiredAt: null,
    ...over
  }
}

function defaultConfig(entityId: string) {
  return {
    flow_preset: "metadataOnly",
    execution_steps_json: JSON.stringify(flowTemplateCatalog.flowTemplates.metadataOnly.steps),
    service_profile_ref: "default",
    environment_policy_ref: "default",
    ownership_team: "sync-platform",
    ownership_owner: null,
    review_status: "legacy-review-required" as const,
    ownership_notes_json: JSON.stringify(["test"])
  }
}

function predicateMapFromScaffold(entity: EntityDefinition): Map<string, string> {
  const authored = scaffoldSyncDefinition(entity, { projectRoot: repoRoot, flowTemplateCatalog })
  return new Map(authored.metadata.tables.map((table) => [table.name, table.predicate]))
}

function resolveBundledStrategy(strategyId: string, _version: number | "latest") {
  return bundledStrategyById(strategyId) ?? null
}

function predicateMapFromCompile(entity: EntityDefinition): Map<string, string> {
  const published = compilePublishedSyncDefinition(
    entity,
    defaultConfig(entity.id),
    flowTemplateCatalog,
    deployFlowCatalog,
    "2026-01-01T00:00:00.000Z",
    "v1",
    resolveBundledStrategy,
  )
  return new Map(published.metadata.tables.map((table) => [table.name, table.predicate]))
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe("sync compiler parity", () => {
  it("freezes scd2Policy per table at publish", () => {
    const entity = makeEntity()
    const published = compilePublishedSyncDefinition(
      entity,
      defaultConfig(entity.id),
      flowTemplateCatalog,
      deployFlowCatalog,
      "2026-01-01T00:00:00.000Z",
      "v1",
      resolveBundledStrategy,
    )
    const policy = published.metadata.tables[0]?.scd2Policy
    expect(policy).toBeDefined()
    expect(policy!.excludeFromDiff).toContain("validFrom")
    expect(policy!.identityHandling).toBe("setIdentityInsertOn")
  })

  it("embeds frozen flow catalog snapshot at publish", () => {
    const entity = makeEntity()
    const published = compilePublishedSyncDefinition(
      entity,
      defaultConfig(entity.id),
      flowTemplateCatalog,
      deployFlowCatalog,
      "2026-01-01T00:00:00.000Z",
      "v1",
      resolveBundledStrategy,
    )
    expect(published.executionFlow.catalog?.kinds["metadataSync"]?.handler.type).toBe("metadata_sync")
    expect(published.executionFlow.catalog?.phases.metadata).toBeDefined()
  })

  it("agrees on rootPk predicates across scaffold and compile", () => {
    const entity = makeEntity()
    const scaffold = predicateMapFromScaffold(entity)
    const compiled = predicateMapFromCompile(entity)

    expect(scaffold.get("core.TestRoot")).toBe("testId = {id}")
    expect(compiled.get("core.TestRoot")).toBe("testId = {id}")
  })

  it("agrees on self-join IN ({ids}) predicates", () => {
    const entity = makeEntity({ selfJoinColumn: "parentTestId" })
    const scaffold = predicateMapFromScaffold(entity)
    const compiled = predicateMapFromCompile(entity)

    expect(scaffold.get("core.TestRoot")).toBe("testId IN ({ids})")
    expect(compiled.get("core.TestRoot")).toBe("testId IN ({ids})")
  })

  it("agrees on verbatim sql predicates", () => {
    const entity = makeEntity({
      tables: [
        tbl({
          name: "core.TestRoot",
          executionOrder: 0,
          scope: { kind: "sql", predicate: "testId = {id} AND isActive = 1" }
        })
      ]
    })
    const expected = "testId = {id} AND isActive = 1"
    expect(predicateMapFromScaffold(entity).get("core.TestRoot")).toBe(expected)
    expect(predicateMapFromCompile(entity).get("core.TestRoot")).toBe(expected)
  })

  it("agrees on multi-hop EXISTS sql predicates", () => {
    const childPredicate = compileFkPathPredicate(
      { selfJoinColumn: null },
      "core.TestChild",
      [{ table: "core.TestChild", fromColumn: "testId", toColumn: "childId" }],
    )
    const entity = makeEntity({
      tables: [
        tbl({
          name: "core.TestRoot",
          executionOrder: 0,
          scope: { kind: "rootPk", column: "testId" },
          scopeColumn: "testId",
        }),
        tbl({
          name: "core.TestChild",
          executionOrder: 1,
          scope: { kind: "sql", predicate: childPredicate },
        }),
      ],
    })

    const scaffoldChild = predicateMapFromScaffold(entity).get("core.TestChild")!
    const compileChild = predicateMapFromCompile(entity).get("core.TestChild")!

    expect(scaffoldChild).toContain("EXISTS")
    expect(compileChild).toBe(scaffoldChild)
  })

  it("projectTablePredicate matches scaffold for every table in a multi-scope entity", () => {
    const entity = makeEntity({
      tables: [
        tbl({ name: "core.A", executionOrder: 0, scope: { kind: "rootPk", column: "testId" } }),
        tbl({
          name: "core.B",
          executionOrder: 1,
          scope: { kind: "sql", predicate: "EXISTS (SELECT 1 FROM core.A a WHERE a.testId = {id})" }
        })
      ]
    })
    for (const table of entity.tables) {
      expect(projectTablePredicate(entity, table)).toBe(predicateMapFromScaffold(entity).get(table.name))
    }
  })

  it("compile preserves custom sql predicates in published metadata", () => {
    const entity = makeEntity({
      id: "customPublished",
      tables: [
        tbl({
          name: "core.Custom",
          executionOrder: 0,
          scope: { kind: "sql", predicate: "customId = {id} AND status <> 'deleted'" }
        })
      ]
    })
    const published = compilePublishedSyncDefinition(
      entity,
      defaultConfig(entity.id),
      flowTemplateCatalog,
      deployFlowCatalog,
      "2026-01-01T00:00:00.000Z",
      "v1",
      resolveBundledStrategy,
    )
    expect(published.id).toBe("customPublished")
    expect(published.metadata.tables[0]?.predicate).toBe("customId = {id} AND status <> 'deleted'")
  })

  it("round-trips a published bundle written to disk", () => {
    const root = mkdtempSync(join(tmpdir(), "sync-compiler-bundle-"))
    tempRoots.push(root)
    mkdirSync(join(root, "sync-definitions", "published"), { recursive: true })

    const entity = makeEntity({ id: "diskEntity" })
    const published = compilePublishedSyncDefinition(
      entity,
      defaultConfig(entity.id),
      flowTemplateCatalog,
      deployFlowCatalog,
      "2026-06-01T00:00:00.000Z",
      "disk-v1",
      resolveBundledStrategy,
    )
    const bundlePath = join(root, "sync-definitions", "published", "definitions.bundle.json")
    writeFileSync(
      bundlePath,
      JSON.stringify(
        {
          version: 1,
          publishedAt: published.publishedAt,
          publishedVersion: published.publishedVersion,
          definitions: { diskEntity: published }
        },
        null,
        2
      )
    )

    const loaded = JSON.parse(readFileSync(bundlePath, "utf-8")).definitions.diskEntity
    expect(loaded.metadata.tables[0]?.predicate).toBe("testId = {id}")
  })
})
