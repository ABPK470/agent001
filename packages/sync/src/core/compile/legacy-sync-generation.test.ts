import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import type { SyncDefinitionFlowTemplateCatalog } from "@mia/sync"

const repoRoot = resolve(import.meta.dirname, "../../../..")
const evidenceFixture = resolve(repoRoot, "deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json")
const flowTemplatesSeed = resolve(repoRoot, "deploy/sync/artifacts/flow-templates.json")
const catalogCacheFile = "packages/server/data/catalog-cache.uat.json"
const catalogCacheHomeFile = join(homedir(), ".mia", "catalog-cache.uat.json")
const catalogFixtureFile = "deploy/sync/fixtures/catalog-snapshot.fixture.json"
const generatedAt = "2026-05-10T11:19:07.694Z"
const pipelineIds = "692,780,788,791,792,798"

interface DerivedMetadataTable {
  name: string
  scopeColumn: string | null
  predicate: string
  source: "fk+pipeline" | "fk-only" | "pipeline-only" | "manual"
  verified: boolean
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
    columns?: Array<{ name: string; isPK?: boolean }>
  }>
}

function loadCatalogSnapshot(): CatalogSnapshot {
  for (const path of [
    resolve(repoRoot, catalogFixtureFile),
    resolve(repoRoot, catalogCacheFile),
    catalogCacheHomeFile
  ]) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as CatalogSnapshot
  }
  return buildCatalogSnapshotFromEntityArtifacts()
}

function buildCatalogSnapshotFromEntityArtifacts(): CatalogSnapshot {
  const entitiesDir = resolve(repoRoot, "deploy/sync/artifacts/entities")
  const byKey = new Map<string, CatalogSnapshot["tables"][number]>()
  for (const file of readdirSync(entitiesDir).filter((name) => name.endsWith(".json"))) {
    const entity = JSON.parse(readFileSync(join(entitiesDir, file), "utf-8")) as {
      rootTable: string
      idColumn: string
      labelColumn?: string | null
      tables?: Array<{ name: string; scopeColumn?: string | null }>
      metadata?: { tables: Array<{ name: string; scopeColumn: string }> }
    }
    const tables = entity.tables ?? entity.metadata?.tables ?? []
    const [rootSchema, rootName] = entity.rootTable.split(".")
    if (rootSchema && rootName) {
      const rootKey = entity.rootTable.toLowerCase()
      const rootColumns = [{ name: entity.idColumn, isPK: true }]
      if (entity.labelColumn) rootColumns.push({ name: entity.labelColumn, isPK: false })
      byKey.set(rootKey, { schema: rootSchema, name: rootName, columns: rootColumns, fkOutgoing: [] })
    }
    for (const table of tables) {
      const [schema, name] = table.name.split(".")
      if (!schema || !name) continue
      const key = table.name.toLowerCase()
      if (byKey.has(key)) continue
      const scopeColumn = table.scopeColumn ?? entity.idColumn
      const columns = [{ name: scopeColumn, isPK: true }]
      if (entity.rootTable === table.name && entity.labelColumn) {
        columns.push({ name: entity.labelColumn, isPK: false })
      }
      byKey.set(key, { schema, name, columns, fkOutgoing: [] })
    }
  }
  return { tables: [...byKey.values()] }
}

interface LegacyEntityDerivationModule {
  buildCatalogIndex(snapshot: unknown): unknown
  extractSyncObjectCalls(body: string): Array<{
    qualifiedName: string
    idName: string
    idsVar: string | null
    idsQuery?: string | null
    idsSelectColumn?: string | null
  }>
  deriveSyncDefinitions(
    pipelines: unknown,
    catalogIndex: unknown,
    generatedAt: string
  ): DerivedSyncDefinition[]
}

const expectedEntities = {
  content: {
    pipelineId: 692,
    rootTable: "gate.Content",
    idColumn: "contentId",
    labelColumn: "title",
    entrySproc: "core.uspSyncContentObjectsTran",
    requiredTables: ["gate.Content", "gate.ContentLink", "gate.ContentType", "gate.ContentLinkType"]
  },
  gateMetadata: {
    pipelineId: 780,
    rootTable: "gate.MetaTable",
    idColumn: "tableId",
    labelColumn: "name",
    entrySproc: "core.uspSyncDataListObjectsTran",
    requiredTables: ["gate.MetaTable", "gate.MetaView", "gate.MetaColumn", "gate.jsonSchema"]
  },
  contract: {
    pipelineId: 788,
    rootTable: "core.Contract",
    idColumn: "contractId",
    labelColumn: "name",
    entrySproc: "core.uspSyncCoreObjectsTran",
    requiredTables: ["core.ContractColumn", "core.Contract", "core.Dataset", "core.Pipeline", "core.Activity"]
  },
  rule: {
    pipelineId: 791,
    rootTable: "core.Rule",
    idColumn: "ruleId",
    labelColumn: "name",
    entrySproc: "core.uspSyncRuleObjectsTran",
    requiredTables: ["core.Rule", "core.RuleColumn", "core.RuleCondition", "core.RuleLink", "core.RuleType"]
  },
  dataset: {
    pipelineId: 792,
    rootTable: "core.Dataset",
    idColumn: "datasetId",
    labelColumn: "name",
    entrySproc: "core.uspSyncDatasetObjectsTran",
    requiredTables: [
      "core.Dataset",
      "core.DatasetColumn",
      "core.DatasetMapping",
      "core.Pipeline",
      "core.Activity"
    ]
  },
  pipelineActivity: {
    pipelineId: 798,
    rootTable: "core.Pipeline",
    idColumn: "pipelineId",
    labelColumn: "name",
    entrySproc: "core.uspSyncPipelineObjectsTran",
    requiredTables: ["core.Pipeline", "core.Activity"]
  }
}

describe("legacy sync generators", () => {
  it("maps contract legacy audit activities to stable flow step ids", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/sync-metadata-derivation.mjs",
      import.meta.url
    ).href
    const specsPath = new URL("../../../../deploy/sync/helpers/legacy-pipeline-evidence.mjs", import.meta.url)
      .href
    const { buildFlowTemplateCatalogFromPipelines } = (await import(modulePath)) as {
      buildFlowTemplateCatalogFromPipelines: (
        pipelines: unknown[],
        options?: { activitySyncSpecs?: Record<string, unknown> }
      ) => SyncDefinitionFlowTemplateCatalog
    }
    const { loadLegacyActivitySyncSpecs } = (await import(specsPath)) as {
      loadLegacyActivitySyncSpecs: () => Record<string, unknown>
    }
    const evidence = JSON.parse(readFileSync(evidenceFixture, "utf-8"))
    const contractPipeline = evidence.pipelines.find(
      (pipeline: { pipelineId: number }) => pipeline.pipelineId === 788
    )
    const catalog = buildFlowTemplateCatalogFromPipelines([contractPipeline], {
      activitySyncSpecs: loadLegacyActivitySyncSpecs()
    })
    const auditSteps = catalog.flowTemplates.contract.steps.filter((step) => step.kind === "auditCheck")

    expect(auditSteps.map((step) => step.id)).toEqual(["auditCheck", "auditCheckPreDeploy"])
    expect(auditSteps.map((step) => step.title)).toEqual([
      "Audit check (before sync)",
      "Audit check (before deploy)"
    ])
    expect(catalog.flowTemplates.contract.steps.map((step) => step.id)).not.toContain("auditCheck2")
  })

  it("rebuilds flow-templates.json from the reviewed legacy pipeline set", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/sync-metadata-derivation.mjs",
      import.meta.url
    ).href
    const specsPath = new URL("../../../../deploy/sync/helpers/legacy-pipeline-evidence.mjs", import.meta.url)
      .href
    const { buildFlowTemplateCatalogFromPipelines } = (await import(modulePath)) as {
      buildFlowTemplateCatalogFromPipelines: (
        pipelines: unknown[],
        options?: { activitySyncSpecs?: Record<string, unknown> }
      ) => unknown
    }
    const { loadLegacyActivitySyncSpecs } = (await import(specsPath)) as {
      loadLegacyActivitySyncSpecs: () => Record<string, unknown>
    }
    const evidence = JSON.parse(readFileSync(evidenceFixture, "utf-8"))
    const selectedPipelines = evidence.pipelines.filter((pipeline: { pipelineId: number }) =>
      pipelineIds.split(",").map(Number).includes(pipeline.pipelineId)
    )
    const actual = buildFlowTemplateCatalogFromPipelines(selectedPipelines, {
      activitySyncSpecs: loadLegacyActivitySyncSpecs()
    })
    const expected = JSON.parse(readFileSync(flowTemplatesSeed, "utf-8"))
    expect(actual).toEqual(expected)
  })

  it("rebuilds deploy/sync/artifacts/entities from the reviewed legacy pipeline set", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/legacy-entity-derivation.mjs",
      import.meta.url
    ).href
    const { buildCatalogIndex, deriveSyncDefinitions } = (await import(
      modulePath
    )) as LegacyEntityDerivationModule
    const evidence = JSON.parse(readFileSync(evidenceFixture, "utf-8"))
    const catalogSnapshot = loadCatalogSnapshot()
    const usingFallbackCatalog =
      !existsSync(resolve(repoRoot, catalogFixtureFile)) &&
      !existsSync(resolve(repoRoot, catalogCacheFile)) &&
      !existsSync(catalogCacheHomeFile)
    const catalogIndex = buildCatalogIndex(catalogSnapshot)
    const definitions = deriveSyncDefinitions(evidence.pipelines, catalogIndex, generatedAt)
    const byId = new Map<string, DerivedSyncDefinition>(
      definitions.map((definition) => [definition.id, definition])
    )
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
      const pipeline = evidence.pipelines.find(
        (candidate: { pipelineId: number; syncObjectCalls?: unknown[] }) =>
          candidate.pipelineId === expected.pipelineId
      )
      const hasSyncObjectCalls =
        Array.isArray(pipeline?.syncObjectCalls) && pipeline.syncObjectCalls.length > 0
      expect(actual).toBeTruthy()
      if (!actual) throw new Error(`Missing derived definition for ${name}`)
      expect(actual.id).toBe(name)
      expect(actual.rootTable).toBe(expected.rootTable)
      expect(actual.idColumn).toBe(expected.idColumn)
      expect(actual.labelColumn).toBe(expected.labelColumn)
      expect(actual.legacy).toEqual({ pipelineId: expected.pipelineId, entrySproc: expected.entrySproc })
      expect(Array.isArray(actual.metadata.tables)).toBe(true)
      if (usingFallbackCatalog || !hasSyncObjectCalls) {
        const artifactPath = resolve(repoRoot, `deploy/sync/artifacts/entities/${name}.json`)
        const artifact = JSON.parse(readFileSync(artifactPath, "utf-8")) as {
          rootTable: string
          tables?: unknown[]
          metadata?: { tables?: unknown[] }
        }
        expect(actual.metadata.tables.length).toBeGreaterThan(0)
        expect(artifact.rootTable).toBe(expected.rootTable)
        const tableCount = artifact.tables?.length ?? artifact.metadata?.tables?.length ?? 0
        expect(tableCount).toBeGreaterThan(0)
        continue
      }
      expect(actual.metadata.tables.length).toBeGreaterThanOrEqual(expected.requiredTables.length)
      expect(actual.metadata.executionOrder.length).toBeGreaterThan(0)
      expect(actual.metadata.reverseOrder).toEqual([...actual.metadata.executionOrder].reverse())

      const actualTables = new Set(actual.metadata.tables.map((table: { name: string }) => table.name))
      for (const tableName of expected.requiredTables) {
        expect(actualTables.has(tableName), `${name} missing ${tableName}`).toBe(true)
      }

      const positions = new Map(
        actual.metadata.executionOrder.map((tableName, index) => [tableName.toLowerCase(), index])
      )
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

  it("derives contract DatasetMappingColumn from the variable-backed legacy id set, not FK guesswork", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/legacy-entity-derivation.mjs",
      import.meta.url
    ).href
    const { buildCatalogIndex, deriveSyncDefinitions, extractSyncObjectCalls } = (await import(
      modulePath
    )) as LegacyEntityDerivationModule

    const syncObjectCalls = extractSyncObjectCalls(`
      SELECT @datasetMappingIds = STUFF(
        (SELECT DISTINCT N', ' + CONVERT(NVARCHAR(MAX), t.datasetMappingId) FROM (
          SELECT datasetMappingId
          FROM core.DatasetMapping
          WHERE datasetId_Left IN (SELECT datasetId FROM core.Dataset WHERE contractId = @contractId)
        ) AS t
        FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

      EXEC core.uspSyncObjectTran
        @idName = ''''datasetMappingId'''',
        @ids = ''''' + ISNULL(@datasetMappingIds ,0) + ''''',
        @name = ''''DatasetMappingColumn'''',
        @schema = ''''core''''
    `)

    const datasetMappingColumnCall = syncObjectCalls.find(
      (call) => call.qualifiedName === "core.DatasetMappingColumn"
    )
    expect(datasetMappingColumnCall?.idsQuery).toContain("SELECT datasetMappingId FROM core.DatasetMapping")
    expect(datasetMappingColumnCall?.idsSelectColumn).toBe("datasetMappingId")

    const catalogIndex = buildCatalogIndex({
      tables: [
        {
          schema: "core",
          name: "Contract",
          columns: [
            { name: "contractId", isPK: true },
            { name: "name", isPK: false }
          ],
          fkOutgoing: []
        },
        {
          schema: "core",
          name: "Dataset",
          columns: [
            { name: "datasetId", isPK: true },
            { name: "contractId", isPK: false }
          ],
          fkOutgoing: [
            { toSchema: "core", toTable: "Contract", fromColumn: "contractId", toColumn: "contractId" }
          ]
        },
        {
          schema: "core",
          name: "DatasetMapping",
          columns: [
            { name: "datasetMappingId", isPK: true },
            { name: "datasetId_Left", isPK: false }
          ],
          fkOutgoing: [
            { toSchema: "core", toTable: "Dataset", fromColumn: "datasetId_Left", toColumn: "datasetId" }
          ]
        },
        {
          schema: "core",
          name: "DatasetMappingColumn",
          columns: [
            { name: "datasetMappingColumnId", isPK: true },
            { name: "datasetMappingId", isPK: false },
            { name: "datasetColumnId_Left", isPK: false }
          ],
          fkOutgoing: [
            {
              toSchema: "core",
              toTable: "DatasetMapping",
              fromColumn: "datasetMappingId",
              toColumn: "datasetMappingId"
            }
          ]
        }
      ]
    })

    const [definition] = deriveSyncDefinitions(
      [
        {
          pipelineId: 788,
          activities: [{ storedProcedure: "core.uspSyncCoreObjectsTran" }],
          syncObjectCalls
        }
      ],
      catalogIndex,
      generatedAt
    )

    const table = definition.metadata.tables.find((entry) => entry.name === "core.DatasetMappingColumn")
    expect(table).toBeTruthy()
    expect(table?.source).toBe("fk+pipeline")
    expect(table?.verified).toBe(true)
    expect(table?.scopeColumn).toBe("datasetMappingId")
    expect(table?.predicate).toContain("[core].[DatasetMappingColumn].[datasetMappingId]")
    expect(table?.predicate).toContain("SELECT datasetMappingId FROM core.DatasetMapping")
    expect(table?.predicate).toMatch(/\bcontractId\b\s*=\s*\{id\}/)
    expect(table?.predicate).not.toContain("datasetColumnId_Left")
  })

  it("derives content type tables from direct STUFF assignments", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/legacy-entity-derivation.mjs",
      import.meta.url
    ).href
    const { buildCatalogIndex, deriveSyncDefinitions, extractSyncObjectCalls } = (await import(
      modulePath
    )) as LegacyEntityDerivationModule

    const syncObjectCalls = extractSyncObjectCalls(`
      SELECT @contentTypeIds = STUFF(
        ( SELECT N', ' + CONVERT(NVARCHAR(MAX),contentTypeId)
          FROM gate.Content
          WHERE contentId = @contentId
          FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

      SELECT @contentLinkTypeIds = STUFF(
        ( SELECT N', ' + CONVERT(NVARCHAR(MAX),contentLinkTypeId)
          FROM gate.ContentLink
          WHERE contentId = @contentId
          FOR XML PATH(''),TYPE).value('text()[1]','NVARCHAR(MAX)'),1,2,N'')

      EXEC core.uspSyncObjectTran
        @idName = ''''contentTypeId'''',
        @ids = ''''' + CONVERT(VARCHAR(100),@contentTypeIds) + ''''',
        @name = ''''ContentType'''',
        @schema = ''''gate''''

      EXEC core.uspSyncObjectTran
        @idName = ''''contentLinkTypeId'''',
        @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@contentLinkTypeIds,0)) + ''''',
        @name = ''''ContentLinkType'''',
        @schema = ''''gate''''
    `)

    const catalogIndex = buildCatalogIndex({
      tables: [
        {
          schema: "gate",
          name: "Content",
          columns: [
            { name: "contentId", isPK: true },
            { name: "contentTypeId", isPK: false }
          ],
          fkOutgoing: []
        },
        {
          schema: "gate",
          name: "ContentLink",
          columns: [
            { name: "contentLinkId", isPK: true },
            { name: "contentId", isPK: false },
            { name: "contentLinkTypeId", isPK: false }
          ],
          fkOutgoing: [
            { toSchema: "gate", toTable: "Content", fromColumn: "contentId", toColumn: "contentId" }
          ]
        },
        {
          schema: "gate",
          name: "ContentType",
          columns: [{ name: "contentTypeId", isPK: true }],
          fkOutgoing: []
        },
        {
          schema: "gate",
          name: "ContentLinkType",
          columns: [{ name: "contentLinkTypeId", isPK: true }],
          fkOutgoing: []
        }
      ]
    })

    const [definition] = deriveSyncDefinitions(
      [
        {
          pipelineId: 692,
          activities: [{ storedProcedure: "core.uspSyncContentObjectsTran" }],
          syncObjectCalls
        }
      ],
      catalogIndex,
      generatedAt
    )

    const contentType = definition.metadata.tables.find((entry) => entry.name === "gate.ContentType")
    const contentLinkType = definition.metadata.tables.find((entry) => entry.name === "gate.ContentLinkType")
    expect(contentType?.verified).toBe(true)
    expect(contentType?.predicate).toContain("FROM gate.Content WHERE contentId = {id}")
    expect(contentType?.predicate).toContain("[gate].[ContentType].[contentTypeId]")
    expect(contentLinkType?.verified).toBe(true)
    expect(contentLinkType?.predicate).toContain("FROM gate.ContentLink WHERE contentId = {id}")
    expect(contentLinkType?.predicate).toContain("[gate].[ContentLinkType].[contentLinkTypeId]")
  })

  it("derives rule tree scopes from the live rule hierarchy rather than a single rule id", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/legacy-entity-derivation.mjs",
      import.meta.url
    ).href
    const { buildCatalogIndex, deriveSyncDefinitions, extractSyncObjectCalls } = (await import(
      modulePath
    )) as LegacyEntityDerivationModule

    const syncObjectCalls = extractSyncObjectCalls(`
      ;WITH cte (name, ruleId, parentRuleId, lvl) AS (
        SELECT r.[name], r.ruleId, r.parentRuleId, 1 AS lvl
        FROM core.[Rule] AS r
        WHERE ruleId = @ruleId
        UNION ALL
        SELECT r.[name], r.ruleId, r.parentRuleId, lvl + 1 AS lvl
        FROM core.[Rule] AS r
        INNER JOIN cte AS t ON t.ruleId = r.parentRuleId
      )
      SELECT @rulesIds = STUFF((SELECT DISTINCT ',' + CONVERT(VARCHAR(MAX), cte.ruleId) FROM cte FOR XML PATH('')),1,1,'')

      SET @sqlruleInputDatasetIds = N' SELECT @ruleInputDatasetIds = STUFF( ( SELECT DISTINCT '','' + CONVERT(VARCHAR(MAX),inputDatasetId) FROM core.[Rule] WHERE ruleId IN ('+@rulesIds+') FOR XML PATH ('''')),1,1,'''')'
      EXEC sys.sp_executesql @sqlruleInputDatasetIds, N'@ruleInputDatasetIds VARCHAR(MAX) OUT', @ruleInputDatasetIds OUT
      SET @sqlruleOutputDatasetIds = N' SELECT @ruleOutputDatasetIds = STUFF( ( SELECT DISTINCT '','' + CONVERT(VARCHAR(MAX),outputDatasetId) FROM core.[Rule] WHERE ruleId IN ('+@rulesIds+') FOR XML PATH ('''')),1,1,'''')'
      EXEC sys.sp_executesql @sqlruleOutputDatasetIds, N'@ruleOutputDatasetIds VARCHAR(MAX) OUT', @ruleOutputDatasetIds OUT
      SET @ruleDatasetIds = COALESCE(@ruleOutputDatasetIds + ', ', '') + @ruleInputDatasetIds

      SET @sqlDatasetMappingIds = N' SELECT @datasetMappingIds = STUFF( (SELECT DISTINCT N'','' + CONVERT(NVARCHAR(MAX), t.datasetMappingId) FROM ( SELECT datasetMappingId FROM core.DatasetMapping WHERE datasetId_Left IN ('+ @ruleDatasetIds +') ) AS t FOR XML PATH ('''')),1,1,'''')'
      EXEC sys.sp_executesql @sqlDatasetMappingIds, N'@datasetMappingIds VARCHAR(MAX) OUT', @datasetMappingIds OUT

      SET @sqlRuleLinkeTypeIds = N' SELECT @ruleLinkeTypeIds = STUFF( ( SELECT DISTINCT '','' + CONVERT(VARCHAR(MAX),ruleLinkTypeId) FROM core.RuleLink WHERE ruleId IN ('+@rulesIds+') FOR XML PATH ('''')),1,1,'''')'
      EXEC sys.sp_executesql @sqlRuleLinkeTypeIds, N'@ruleLinkeTypeIds VARCHAR(MAX) OUT', @ruleLinkeTypeIds OUT

      SET @sqlruleTypeIds = N' SELECT @ruleTypeIds = STUFF( ( SELECT DISTINCT '','' + CONVERT(VARCHAR(MAX),ruleTypeId) FROM core.[Rule] WHERE ruleId IN ('+@rulesIds+') FOR XML PATH ('''')),1,1,'''')'
      EXEC sys.sp_executesql @sqlruleTypeIds, N'@ruleTypeIds VARCHAR(MAX) OUT', @ruleTypeIds OUT

      SET @sqlRuleConditionIds = N' SELECT @ruleConditionIds = STUFF( ( SELECT DISTINCT '','' + CONVERT(VARCHAR(MAX),ruleConditionId) FROM core.RuleCondition WHERE ruleId IN ('+@rulesIds+') FOR XML PATH ('''')),1,1,'''')'
      EXEC sys.sp_executesql @sqlRuleConditionIds, N'@ruleConditionIds VARCHAR(MAX) OUT', @ruleConditionIds OUT

      EXEC core.uspSyncObjectTran @idName = ''''ruleId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),@rulesIds) + ''''', @name = ''''Rule'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''ruleId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),@rulesIds) + ''''', @name = ''''RuleColumn'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''ruleId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),@rulesIds) + ''''', @name = ''''RuleCondition'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''ruleConditionId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@ruleConditionIds,0)) + ''''', @name = ''''RuleConditionValue'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''ruleId'''', @ids = ''''' + CONVERT(VARCHAR(MAX), @rulesIds) + ''''', @name = ''''RuleLink'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''ruleLinkTypeId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@ruleLinkeTypeIds,0)) + ''''', @name = ''''RuleLinkType'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''ruleTypeId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@ruleTypeIds,0)) + ''''', @name = ''''RuleType'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''datasetId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@ruleDatasetIds,0)) + ''''', @name = ''''Dataset'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''datasetId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@ruleDatasetIds,0)) + ''''', @name = ''''DatasetColumn'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''datasetMappingId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@datasetMappingIds,0)) + ''''', @name = ''''DatasetMapping'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''datasetMappingId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@datasetMappingIds,0)) + ''''', @name = ''''DatasetMappingColumn'''', @schema = ''''core''''
    `)

    const catalogIndex = buildCatalogIndex({
      tables: [
        {
          schema: "core",
          name: "Rule",
          columns: [
            { name: "ruleId", isPK: true },
            { name: "parentRuleId", isPK: false },
            { name: "ruleTypeId", isPK: false },
            { name: "inputDatasetId", isPK: false },
            { name: "outputDatasetId", isPK: false },
            { name: "name", isPK: false }
          ],
          fkOutgoing: []
        },
        {
          schema: "core",
          name: "RuleColumn",
          columns: [{ name: "ruleId", isPK: false }],
          fkOutgoing: [{ toSchema: "core", toTable: "Rule", fromColumn: "ruleId", toColumn: "ruleId" }]
        },
        {
          schema: "core",
          name: "RuleCondition",
          columns: [
            { name: "ruleConditionId", isPK: true },
            { name: "ruleId", isPK: false }
          ],
          fkOutgoing: [{ toSchema: "core", toTable: "Rule", fromColumn: "ruleId", toColumn: "ruleId" }]
        },
        {
          schema: "core",
          name: "RuleConditionValue",
          columns: [{ name: "ruleConditionId", isPK: false }],
          fkOutgoing: [
            {
              toSchema: "core",
              toTable: "RuleCondition",
              fromColumn: "ruleConditionId",
              toColumn: "ruleConditionId"
            }
          ]
        },
        {
          schema: "core",
          name: "RuleLink",
          columns: [
            { name: "ruleId", isPK: false },
            { name: "ruleLinkTypeId", isPK: false }
          ],
          fkOutgoing: [{ toSchema: "core", toTable: "Rule", fromColumn: "ruleId", toColumn: "ruleId" }]
        },
        {
          schema: "core",
          name: "RuleLinkType",
          columns: [{ name: "ruleLinkTypeId", isPK: true }],
          fkOutgoing: []
        },
        {
          schema: "core",
          name: "RuleType",
          columns: [{ name: "ruleTypeId", isPK: true }],
          fkOutgoing: []
        },
        {
          schema: "core",
          name: "Dataset",
          columns: [{ name: "datasetId", isPK: true }],
          fkOutgoing: []
        },
        {
          schema: "core",
          name: "DatasetColumn",
          columns: [{ name: "datasetId", isPK: false }],
          fkOutgoing: [
            { toSchema: "core", toTable: "Dataset", fromColumn: "datasetId", toColumn: "datasetId" }
          ]
        },
        {
          schema: "core",
          name: "DatasetMapping",
          columns: [
            { name: "datasetMappingId", isPK: true },
            { name: "datasetId_Left", isPK: false }
          ],
          fkOutgoing: [
            { toSchema: "core", toTable: "Dataset", fromColumn: "datasetId_Left", toColumn: "datasetId" }
          ]
        },
        {
          schema: "core",
          name: "DatasetMappingColumn",
          columns: [{ name: "datasetMappingId", isPK: false }],
          fkOutgoing: [
            {
              toSchema: "core",
              toTable: "DatasetMapping",
              fromColumn: "datasetMappingId",
              toColumn: "datasetMappingId"
            }
          ]
        }
      ]
    })

    const [definition] = deriveSyncDefinitions(
      [
        {
          pipelineId: 791,
          activities: [{ storedProcedure: "core.uspSyncRuleObjectsTran" }],
          syncObjectCalls
        }
      ],
      catalogIndex,
      generatedAt
    )

    const rule = definition.metadata.tables.find((entry) => entry.name === "core.Rule")
    const ruleValue = definition.metadata.tables.find((entry) => entry.name === "core.RuleConditionValue")
    const dataset = definition.metadata.tables.find((entry) => entry.name === "core.Dataset")
    const mappingColumn = definition.metadata.tables.find(
      (entry) => entry.name === "core.DatasetMappingColumn"
    )
    const linkType = definition.metadata.tables.find((entry) => entry.name === "core.RuleLinkType")

    expect(rule?.verified).toBe(true)
    expect(rule?.predicate).toContain("[core].[fRule]({id})")
    expect(rule?.predicate).not.toBe("ruleId = {id}")
    expect(ruleValue?.verified).toBe(true)
    expect(ruleValue?.predicate).toContain("[core].[RuleCondition] rc")
    expect(ruleValue?.predicate).toContain("[core].[fRule]({id})")
    expect(dataset?.verified).toBe(true)
    expect(dataset?.predicate).toContain("inputDatasetId")
    expect(dataset?.predicate).toContain("outputDatasetId")
    expect(mappingColumn?.verified).toBe(true)
    expect(mappingColumn?.predicate).toContain("[core].[DatasetMapping] dm")
    expect(mappingColumn?.predicate).toContain("datasetId_Left")
    expect(linkType?.verified).toBe(true)
    expect(linkType?.predicate).toContain("[core].[RuleLink] rl")
  })

  it("derives dataset mapping columns from dataset mappings, not datasetColumnId_Left", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/legacy-entity-derivation.mjs",
      import.meta.url
    ).href
    const { buildCatalogIndex, deriveSyncDefinitions, extractSyncObjectCalls } = (await import(
      modulePath
    )) as LegacyEntityDerivationModule

    const syncObjectCalls = extractSyncObjectCalls(`
      EXEC core.uspSyncObjectTran @idName = ''''pipelineId'''', @ids = ''''' + CONVERT(VARCHAR(1000), ISNULL(@pipelineIds,0)) + ''''', @name = ''''Pipeline'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''pipelineId'''', @ids = ''''' + CONVERT(VARCHAR(1000), ISNULL(@pipelineIds,0)) + ''''', @name = ''''Activity'''', @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''datasetMappingId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@datasetMappingIds,0)) + ''''', @name = ''''DatasetMapping'''' , @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''datasetMappingId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),ISNULL(@datasetMappingIds,0)) + ''''', @name = ''''DatasetMappingColumn'''' , @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''datasetId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),@datasetIds) + ''''', @name = ''''Dataset'''' , @schema = ''''core''''
      EXEC core.uspSyncObjectTran @idName = ''''datasetId'''', @ids = ''''' + CONVERT(VARCHAR(MAX),@datasetIds) + ''''', @name = ''''DatasetColumn'''' , @schema = ''''core''''
    `)

    const catalogIndex = buildCatalogIndex({
      tables: [
        {
          schema: "core",
          name: "Dataset",
          columns: [
            { name: "datasetId", isPK: true },
            { name: "name", isPK: false },
            { name: "parentDatasetId", isPK: false }
          ],
          fkOutgoing: []
        },
        {
          schema: "core",
          name: "Pipeline",
          columns: [
            { name: "pipelineId", isPK: true },
            { name: "datasetId", isPK: false }
          ],
          fkOutgoing: [
            { toSchema: "core", toTable: "Dataset", fromColumn: "datasetId", toColumn: "datasetId" }
          ]
        },
        {
          schema: "core",
          name: "Activity",
          columns: [{ name: "pipelineId", isPK: false }],
          fkOutgoing: [
            { toSchema: "core", toTable: "Pipeline", fromColumn: "pipelineId", toColumn: "pipelineId" }
          ]
        },
        {
          schema: "core",
          name: "DatasetColumn",
          columns: [
            { name: "datasetColumnId", isPK: true },
            { name: "datasetId", isPK: false }
          ],
          fkOutgoing: [
            { toSchema: "core", toTable: "Dataset", fromColumn: "datasetId", toColumn: "datasetId" }
          ]
        },
        {
          schema: "core",
          name: "DatasetMapping",
          columns: [
            { name: "datasetMappingId", isPK: true },
            { name: "datasetId_Left", isPK: false }
          ],
          fkOutgoing: [
            { toSchema: "core", toTable: "Dataset", fromColumn: "datasetId_Left", toColumn: "datasetId" }
          ]
        },
        {
          schema: "core",
          name: "DatasetMappingColumn",
          columns: [
            { name: "datasetMappingColumnId", isPK: true },
            { name: "datasetMappingId", isPK: false },
            { name: "datasetColumnId_Left", isPK: false }
          ],
          fkOutgoing: [
            {
              toSchema: "core",
              toTable: "DatasetMapping",
              fromColumn: "datasetMappingId",
              toColumn: "datasetMappingId"
            },
            {
              toSchema: "core",
              toTable: "DatasetColumn",
              fromColumn: "datasetColumnId_Left",
              toColumn: "datasetColumnId"
            }
          ]
        }
      ]
    })

    const [definition] = deriveSyncDefinitions(
      [
        {
          pipelineId: 792,
          activities: [{ storedProcedure: "core.uspSyncDatasetObjectsTran" }],
          syncObjectCalls
        }
      ],
      catalogIndex,
      generatedAt
    )

    const dataset = definition.metadata.tables.find((entry) => entry.name === "core.Dataset")
    const datasetColumn = definition.metadata.tables.find((entry) => entry.name === "core.DatasetColumn")
    const mapping = definition.metadata.tables.find((entry) => entry.name === "core.DatasetMapping")
    const pipeline = definition.metadata.tables.find((entry) => entry.name === "core.Pipeline")
    const mappingColumn = definition.metadata.tables.find(
      (entry) => entry.name === "core.DatasetMappingColumn"
    )

    expect(dataset?.verified).toBe(true)
    expect(dataset?.predicate).toBe("datasetId = {id}")
    expect(datasetColumn?.verified).toBe(true)
    expect(datasetColumn?.predicate).toBe("datasetId = {id}")
    expect(mapping?.verified).toBe(true)
    expect(mapping?.predicate).toBe("datasetId_Left = {id}")
    expect(pipeline?.verified).toBe(true)
    expect(pipeline?.predicate).toBe("datasetId = {id}")
    expect(mappingColumn?.verified).toBe(true)
    expect(mappingColumn?.predicate).toContain("[core].[DatasetMapping] dm")
    expect(mappingColumn?.predicate).toContain("dm.[datasetId_Left] = {id}")
    expect(mappingColumn?.predicate).not.toContain("datasetColumnId_Left")
  })

  it("derives gate metadata columns and json schema through meta views", async () => {
    const modulePath = new URL(
      "../../../../deploy/sync/helpers/legacy-entity-derivation.mjs",
      import.meta.url
    ).href
    const { buildCatalogIndex, deriveSyncDefinitions, extractSyncObjectCalls } = (await import(
      modulePath
    )) as LegacyEntityDerivationModule

    const syncObjectCalls = extractSyncObjectCalls(`
      EXEC core.uspSyncObjectTran @idName = ''''jsonSchemaId'''', @ids = ''''' +CONVERT(VARCHAR(1000),ISNULL(@jsonSchemaIds,0)) + ''''', @name = ''''jsonSchema'''', @schema = ''''gate''''
      EXEC core.uspSyncObjectTran @idName = ''''viewId'''', @ids = ''''' + CONVERT(VARCHAR(1000),ISNULL(@metaViewIds,0)) + ''''', @name = ''''metaColumn'''', @schema = ''''gate''''
      EXEC core.uspSyncObjectTran @idName = ''''viewId'''', @ids = ''''' + CONVERT(VARCHAR(1000),ISNULL(@metaViewIds,0)) + ''''', @name = ''''metaView'''', @schema = ''''gate''''
      EXEC core.uspSyncObjectTran @idName = ''''tableId'''', @ids = ''''' + CONVERT(VARCHAR(100), @tableId) + ''''', @name = ''''metaTable'''', @schema = ''''gate''''
    `)

    const catalogIndex = buildCatalogIndex({
      tables: [
        {
          schema: "gate",
          name: "MetaTable",
          columns: [
            { name: "tableId", isPK: true },
            { name: "name", isPK: false }
          ],
          fkOutgoing: []
        },
        {
          schema: "gate",
          name: "MetaView",
          columns: [
            { name: "viewId", isPK: true },
            { name: "tableId", isPK: false }
          ],
          fkOutgoing: [{ toSchema: "gate", toTable: "MetaTable", fromColumn: "tableId", toColumn: "tableId" }]
        },
        {
          schema: "gate",
          name: "MetaColumn",
          columns: [
            { name: "columnId", isPK: true },
            { name: "viewId", isPK: false },
            { name: "jsonSchemaId", isPK: false }
          ],
          fkOutgoing: [{ toSchema: "gate", toTable: "MetaView", fromColumn: "viewId", toColumn: "viewId" }]
        },
        {
          schema: "gate",
          name: "jsonSchema",
          columns: [{ name: "jsonSchemaId", isPK: true }],
          fkOutgoing: []
        }
      ]
    })

    const [definition] = deriveSyncDefinitions(
      [
        {
          pipelineId: 780,
          activities: [{ storedProcedure: "core.uspSyncDataListObjectsTran" }],
          syncObjectCalls
        }
      ],
      catalogIndex,
      generatedAt
    )

    const metaView = definition.metadata.tables.find((entry) => entry.name === "gate.MetaView")
    const metaColumn = definition.metadata.tables.find((entry) => entry.name === "gate.MetaColumn")
    const jsonSchema = definition.metadata.tables.find((entry) => entry.name === "gate.jsonSchema")

    expect(metaView?.verified).toBe(true)
    expect(metaView?.predicate).toBe("tableId = {id}")
    expect(metaColumn?.verified).toBe(true)
    expect(metaColumn?.predicate).toContain("[gate].[MetaView] mv")
    expect(metaColumn?.predicate).toContain("mv.[tableId] = {id}")
    expect(metaColumn?.predicate).toContain(".[viewId]")
    expect(jsonSchema?.verified).toBe(true)
    expect(jsonSchema?.predicate).toContain("[gate].[MetaColumn] mc")
    expect(jsonSchema?.predicate).toContain("mc.[jsonSchemaId] = [gate].[jsonSchema].[jsonSchemaId]")
    expect(jsonSchema?.predicate).toContain("mv.[tableId] = {id}")
  })
})
