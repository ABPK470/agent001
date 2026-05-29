import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

const repoRoot = resolve(import.meta.dirname, "../../../..")
const entitiesScript = resolve(repoRoot, "deploy/sync/generators/generate-entities-from-legacy-pipelines.mjs")
const flowTemplatesScript = resolve(repoRoot, "deploy/sync/generators/generate-flow-templates-from-legacy-pipelines.mjs")
const evidenceFixture = resolve(repoRoot, "notes/sync/legacy-pipeline-evidence.fixture.json")
const flowTemplatesSeed = resolve(repoRoot, "deploy/sync/artifacts/flow-templates.json")
const catalogCacheFile = "packages/server/data/catalog-cache.uat.json"
const generatedAt = "2026-05-10T11:19:07.694Z"
const pipelineIds = "692,780,788,791,792,798"

interface DerivedMetadataTable {
  name: string
  predicate: string
  source: "fk+pipeline" | "fk-only" | "pipeline-only"
}

interface DerivedSyncDefinition {
  id: string
  rootTable: string
  idColumn: string
  labelColumn: string | null
  legacy: {
    pipelineId: number | null
    entrySproc: string | null
  }
  metadata: {
    tables: DerivedMetadataTable[]
    executionOrder: string[]
    reverseOrder: string[]
  }
}

interface CatalogSnapshot {
  tables: Array<{
    schema: string
    name: string
    fkOutgoing?: Array<{ toSchema: string; toTable: string }>
  }>
}

interface LegacyEntityDerivationModule {
  buildCatalogIndex(snapshot: unknown): unknown
  deriveSyncDefinitions(pipelines: unknown, catalogIndex: unknown, generatedAt: string): DerivedSyncDefinition[]
}

const expectedEntities = {
  content: {
    pipelineId: 692,
    rootTable: "gate.Content",
    idColumn: "contentId",
    labelColumn: "title",
    entrySproc: "core.uspSyncContentObjectsTran",
    requiredTables: ["gate.Content", "gate.ContentLink", "gate.ContentType", "gate.ContentLinkType"],
  },
  gateMetadata: {
    pipelineId: 780,
    rootTable: "gate.MetaTable",
    idColumn: "tableId",
    labelColumn: "name",
    entrySproc: "core.uspSyncDataListObjectsTran",
    requiredTables: ["gate.MetaTable", "gate.MetaView", "gate.MetaColumn", "gate.jsonSchema"],
  },
  contract: {
    pipelineId: 788,
    rootTable: "core.Contract",
    idColumn: "contractId",
    labelColumn: "name",
    entrySproc: "core.uspSyncCoreObjectsTran",
    requiredTables: ["core.ContractColumn", "core.Contract", "core.Dataset", "core.Pipeline", "core.Activity"],
  },
  rule: {
    pipelineId: 791,
    rootTable: "core.Rule",
    idColumn: "ruleId",
    labelColumn: "name",
    entrySproc: "core.uspSyncRuleObjectsTran",
    requiredTables: ["core.Rule", "core.RuleColumn", "core.RuleCondition", "core.RuleLink", "core.RuleType"],
  },
  dataset: {
    pipelineId: 792,
    rootTable: "core.Dataset",
    idColumn: "datasetId",
    labelColumn: "name",
    entrySproc: "core.uspSyncDatasetObjectsTran",
    requiredTables: ["core.Dataset", "core.DatasetColumn", "core.DatasetMapping", "core.Pipeline", "core.Activity"],
  },
  pipelineActivity: {
    pipelineId: 798,
    rootTable: "core.Pipeline",
    idColumn: "pipelineId",
    labelColumn: "name",
    entrySproc: "core.uspSyncPipelineObjectsTran",
    requiredTables: ["core.Pipeline", "core.Activity"],
  },
}

describe("legacy sync generators", () => {
  it("rebuilds flow-templates.json from the reviewed legacy pipeline set", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "legacy-flow-templates-"))
    const outputPath = join(tempRoot, "flow-templates.json")

    execFileSync("node", [
      flowTemplatesScript,
      "--pipeline-ids", pipelineIds,
      "--evidence-file", evidenceFixture,
      "--output", outputPath,
      "--force",
    ], { cwd: repoRoot, stdio: "pipe" })

    const actual = JSON.parse(readFileSync(outputPath, "utf-8"))
    const expected = JSON.parse(readFileSync(flowTemplatesSeed, "utf-8"))
    expect(actual).toEqual(expected)
  })

  it("rebuilds deploy/sync/artifacts/entities from the reviewed legacy pipeline set", async () => {
    const modulePath = new URL("../../../../deploy/sync/helpers/legacy-entity-derivation.mjs", import.meta.url).href
    const { buildCatalogIndex, deriveSyncDefinitions } = await import(modulePath) as LegacyEntityDerivationModule
    const evidence = JSON.parse(readFileSync(evidenceFixture, "utf-8"))
    const catalogSnapshot = JSON.parse(readFileSync(resolve(repoRoot, catalogCacheFile), "utf-8")) as CatalogSnapshot
    const catalogIndex = buildCatalogIndex(catalogSnapshot)
    const definitions = deriveSyncDefinitions(evidence.pipelines, catalogIndex, generatedAt)
    const byId = new Map<string, DerivedSyncDefinition>(definitions.map((definition) => [definition.id, definition]))
    const fkChildrenByParent = new Map<string, Set<string>>()
    for (const table of catalogSnapshot.tables) {
      const child = `${table.schema}.${table.name}`.toLowerCase()
      for (const fk of table.fkOutgoing ?? []) {
        const parent = `${fk.toSchema}.${fk.toTable}`.toLowerCase()
        if (parent === child) continue
        let children = fkChildrenByParent.get(parent)
        if (!children) {
          children = new Set<string>()
          fkChildrenByParent.set(parent, children)
        }
        children.add(child)
      }
    }

    for (const name of Object.keys(expectedEntities)) {
      const actual = byId.get(name)
      const expected = expectedEntities[name as keyof typeof expectedEntities]
      expect(actual).toBeTruthy()
      if (!actual) throw new Error(`Missing derived definition for ${name}`)
      expect(actual.id).toBe(name)
      expect(actual.rootTable).toBe(expected.rootTable)
      expect(actual.idColumn).toBe(expected.idColumn)
      expect(actual.labelColumn).toBe(expected.labelColumn)
      expect(actual.legacy).toEqual({ pipelineId: expected.pipelineId, entrySproc: expected.entrySproc })
      expect(Array.isArray(actual.metadata.tables)).toBe(true)
      expect(actual.metadata.tables.length).toBeGreaterThanOrEqual(expected.requiredTables.length)
      expect(actual.metadata.executionOrder.length).toBeGreaterThan(0)
      expect(actual.metadata.reverseOrder).toEqual([...actual.metadata.executionOrder].reverse())

      const actualTables = new Set(actual.metadata.tables.map((table: { name: string }) => table.name))
      for (const tableName of expected.requiredTables) {
        expect(actualTables.has(tableName), `${name} missing ${tableName}`).toBe(true)
      }

      const positions = new Map(actual.metadata.executionOrder.map((tableName, index) => [tableName.toLowerCase(), index]))
      for (const [parent, children] of fkChildrenByParent) {
        if (!positions.has(parent)) continue
        const parentPos = positions.get(parent)
        if (parentPos == null) continue
        for (const child of children) {
          if (!positions.has(child)) continue
          const childPos = positions.get(child)
          if (childPos == null) continue
          expect(parentPos).toBeLessThan(childPos)
        }
      }

      for (const table of actual.metadata.tables) {
        expect(typeof table.name).toBe("string")
        expect(typeof table.predicate).toBe("string")
        expect(table.predicate.length).toBeGreaterThan(0)
        expect(["fk+pipeline", "fk-only", "pipeline-only"]).toContain(table.source)
      }
    }
  })
})