#!/usr/bin/env node

import sql from "mssql"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../..")
const DEFAULT_RECIPES_OUT = "deploy/mssql/sync-recipes.json"
const DEFAULT_DEFINITIONS_DIR = "deploy/sync/entities"

const BOOTSTRAP_ENTITIES = [
  {
    id: "content",
    displayName: "Content",
    rootTable: "gate.Content",
    idColumn: "contentId",
    labelColumn: "title",
    selfJoinColumn: "parentContentId",
    pipelineId: 692,
    pipelineName: "Synchronize Content Transaction",
    entrySproc: "core.uspSyncContentObjectsTran",
    reviewStatus: "legacy-review-required",
    tables: [
      { name: "gate.Content", scopeColumn: "contentId", predicate: "contentId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "gate.ContentLink", scopeColumn: "contentId", predicate: "contentId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "gate.UserGroupPermission", scopeColumn: "contentId", predicate: "contentId = {id}", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncContentObjectsTran body." },
      { name: "gate.ContentType", scopeColumn: "contentTypeId", predicate: "contentTypeId IN (SELECT contentTypeId FROM [gate].[Content] WHERE contentId = {id})", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "gate.ContentLinkType", scopeColumn: "contentLinkTypeId", predicate: "contentLinkTypeId IN (SELECT contentLinkTypeId FROM [gate].[ContentLink] WHERE contentId = {id})", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false }
    ],
    executionOrder: ["gate.Content", "gate.ContentLink", "gate.ContentType", "gate.ContentLinkType", "gate.UserGroupPermission"],
    reverseOrder: ["gate.UserGroupPermission", "gate.ContentLinkType", "gate.ContentType", "gate.ContentLink", "gate.Content"],
  },
  {
    id: "gateMetadata",
    displayName: "Gate Metadata",
    rootTable: "gate.MetaTable",
    idColumn: "tableId",
    labelColumn: "name",
    selfJoinColumn: null,
    pipelineId: 780,
    pipelineName: "Synchronize Gate Transaction",
    entrySproc: "core.uspSyncDataListObjectsTran",
    reviewStatus: "legacy-review-required",
    tables: [
      { name: "gate.MetaTable", scopeColumn: "tableId", predicate: "tableId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "gate.MetaColumn", scopeColumn: "viewId", predicate: "viewId IN (SELECT viewId FROM [gate].[MetaView] WHERE tableId IN ( {id} ))", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "gate.MetaView", scopeColumn: "viewId", predicate: "viewId IN (SELECT viewId FROM [gate].[MetaView] WHERE tableId IN ( {id} ))", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "gate.Content", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [gate].[MetaView] p WHERE p.viewId = [gate].[Content].viewId AND p.tableId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDataListObjectsTran body." },
      { name: "gate.ContentLink", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [gate].[Content] p INNER JOIN [gate].[MetaView] _p1 ON _p1.viewId = p.viewId WHERE p.contentId = [gate].[ContentLink].contentId AND _p1.tableId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDataListObjectsTran body." },
      { name: "gate.UserGroupPermission", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [gate].[Content] p INNER JOIN [gate].[MetaView] _p1 ON _p1.viewId = p.viewId WHERE p.contentId = [gate].[UserGroupPermission].contentId AND _p1.tableId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDataListObjectsTran body." },
      { name: "gate.jsonSchema", scopeColumn: "jsonSchemaId", predicate: "jsonSchemaId IN (SELECT jsonSchemaId FROM [gate].[MetaColumn] WHERE columnId IN ( (SELECT columnId FROM [gate].[MetaColumn] WHERE viewId IN ( (SELECT viewId FROM [gate].[MetaView] WHERE tableId IN ( {id} )) )) ))", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false }
    ],
    executionOrder: ["gate.jsonSchema", "gate.MetaColumn", "gate.MetaView", "gate.MetaTable", "gate.Content", "gate.ContentLink", "gate.UserGroupPermission"],
    reverseOrder: ["gate.UserGroupPermission", "gate.ContentLink", "gate.Content", "gate.MetaTable", "gate.MetaView", "gate.MetaColumn", "gate.jsonSchema"],
  },
  {
    id: "contract",
    displayName: "Contract",
    rootTable: "core.Contract",
    idColumn: "contractId",
    labelColumn: "name",
    selfJoinColumn: null,
    pipelineId: 788,
    pipelineName: "Synchronize Contract Transaction",
    entrySproc: "core.uspSyncCoreObjectsTran",
    reviewStatus: "legacy-review-required",
    tables: [
      { name: "core.Contract", scopeColumn: "contractId", predicate: "contractId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.Pipeline", scopeColumn: "contractId", predicate: "contractId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.ContractColumn", scopeColumn: "contractId", predicate: "contractId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.Dataset", scopeColumn: "contractId", predicate: "contractId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.Step", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[Pipeline] p WHERE p.pipelineId = [core].[Step].pipelineId AND p.contractId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncCoreObjectsTran body." },
      { name: "core.Activity", scopeColumn: "pipelineId", predicate: "pipelineId IN (SELECT pipelineId FROM [core].[Pipeline] WHERE contractId = {id})", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.DatasetColumn", scopeColumn: "datasetId", predicate: "datasetId IN (SELECT datasetId FROM [core].[Dataset] WHERE contractId = {id})", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.DatasetMapping", scopeColumn: "datasetId_Left", predicate: "datasetId_Left IN (SELECT datasetId FROM [core].[Dataset] WHERE contractId = {id})", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.Rule", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[Dataset] p WHERE p.datasetId = [core].[Rule].inputDatasetId AND p.contractId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncCoreObjectsTran body." },
      { name: "core.DatasetMappingColumn", scopeColumn: "datasetMappingId", predicate: "datasetMappingId IN (SELECT datasetMappingId FROM [core].[DatasetMapping] WHERE datasetId_Left IN (SELECT datasetId FROM core.Dataset WHERE contractId = {id}) )", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleColumn", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[DatasetColumn] p INNER JOIN [core].[Dataset] _p1 ON _p1.datasetId = p.lookupDatasetId WHERE p.datasetColumnId = [core].[RuleColumn].inputDatasetColumnId AND _p1.contractId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncCoreObjectsTran body." },
      { name: "core.RuleCondition", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[DatasetColumn] p INNER JOIN [core].[Dataset] _p1 ON _p1.datasetId = p.lookupDatasetId WHERE p.datasetColumnId = [core].[RuleCondition].inputDatasetColumnId AND _p1.contractId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncCoreObjectsTran body." },
      { name: "core.RuleLink", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[DatasetColumn] p INNER JOIN [core].[Dataset] _p1 ON _p1.datasetId = p.lookupDatasetId WHERE p.datasetColumnId = [core].[RuleLink].outputDatasetColumnId AND _p1.contractId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncCoreObjectsTran body." },
      { name: "core.RuleConditionValue", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[RuleCondition] p INNER JOIN [core].[DatasetColumn] _p1 ON _p1.datasetColumnId = p.inputDatasetColumnId INNER JOIN [core].[Dataset] _p2 ON _p2.datasetId = _p1.lookupDatasetId WHERE p.ruleConditionId = [core].[RuleConditionValue].ruleConditionId AND _p2.contractId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncCoreObjectsTran body." }
    ],
    executionOrder: ["core.ContractColumn", "core.Contract", "core.DatasetMappingColumn", "core.DatasetMapping", "core.DatasetColumn", "core.Dataset", "core.Activity", "core.Pipeline", "core.Step", "core.Rule", "core.RuleColumn", "core.RuleCondition", "core.RuleLink", "core.RuleConditionValue"],
    reverseOrder: ["core.RuleConditionValue", "core.RuleLink", "core.RuleCondition", "core.RuleColumn", "core.Rule", "core.Step", "core.Pipeline", "core.Activity", "core.Dataset", "core.DatasetColumn", "core.DatasetMapping", "core.DatasetMappingColumn", "core.Contract", "core.ContractColumn"],
  },
  {
    id: "rule",
    displayName: "Rule",
    rootTable: "core.Rule",
    idColumn: "ruleId",
    labelColumn: "name",
    selfJoinColumn: "parentRuleId",
    pipelineId: 791,
    pipelineName: "Synchronize Rules Transaction",
    entrySproc: "core.uspSyncRuleObjectsTran",
    reviewStatus: "reviewed",
    tables: [
      { name: "core.Rule", scopeColumn: "ruleId", predicate: "ruleId IN (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleColumn", scopeColumn: "ruleId", predicate: "ruleId IN (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleCondition", scopeColumn: "ruleId", predicate: "ruleId IN (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleLink", scopeColumn: "ruleId", predicate: "ruleId IN (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleConditionValue", scopeColumn: "ruleConditionId", predicate: "ruleConditionId IN (SELECT ruleConditionId FROM [core].[RuleCondition] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})))", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.DatasetMappingColumn", scopeColumn: "datasetMappingId", predicate: "datasetMappingId IN (SELECT datasetMappingId FROM [core].[DatasetMapping] WHERE datasetId_Left IN ( (SELECT outputDatasetId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id}) UNION SELECT inputDatasetId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})) ) )))", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.DatasetMapping", scopeColumn: "datasetMappingId", predicate: "datasetMappingId IN (SELECT datasetMappingId FROM [core].[DatasetMapping] WHERE datasetId_Left IN ( (SELECT outputDatasetId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id}) UNION SELECT inputDatasetId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})) ) )))", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.DatasetColumn", scopeColumn: "datasetId", predicate: "datasetId IN (SELECT outputDatasetId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id}) UNION SELECT inputDatasetId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id}))))", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.Dataset", scopeColumn: "datasetId", predicate: "datasetId IN (SELECT outputDatasetId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id}) UNION SELECT inputDatasetId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id}))))", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleLinkType", scopeColumn: "ruleLinkTypeId", predicate: "ruleLinkTypeId IN (SELECT ruleLinkTypeId FROM [core].[RuleLink] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})))", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleType", scopeColumn: "ruleTypeId", predicate: "ruleTypeId IN (SELECT ruleTypeId FROM [core].[Rule] WHERE ruleId IN ( (SELECT ruleId FROM [core].[Rule] WHERE ruleId = {id})))", source: "pipeline-only", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false }
    ],
    executionOrder: ["core.DatasetMappingColumn", "core.DatasetMapping", "core.DatasetColumn", "core.Dataset", "core.RuleLinkType", "core.RuleLink", "core.RuleConditionValue", "core.RuleCondition", "core.RuleType", "core.RuleColumn", "core.Rule"],
    reverseOrder: ["core.Rule", "core.RuleColumn", "core.RuleType", "core.RuleCondition", "core.RuleConditionValue", "core.RuleLink", "core.RuleLinkType", "core.Dataset", "core.DatasetColumn", "core.DatasetMapping", "core.DatasetMappingColumn"],
  },
  {
    id: "dataset",
    displayName: "Dataset",
    rootTable: "core.Dataset",
    idColumn: "datasetId",
    labelColumn: "name",
    selfJoinColumn: "parentDatasetId",
    pipelineId: 792,
    pipelineName: "Synchronize Dataset Transaction",
    entrySproc: "core.uspSyncDatasetObjectsTran",
    reviewStatus: "legacy-review-required",
    tables: [
      { name: "core.Dataset", scopeColumn: "datasetId", predicate: "datasetId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.DatasetColumn", scopeColumn: "datasetId", predicate: "datasetId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.DatasetMapping", scopeColumn: "datasetMappingId", predicate: "datasetMappingId IN (SELECT datasetMappingId FROM [core].[DatasetMapping] WHERE datasetId_Left IN ( {id}))", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.Rule", scopeColumn: "inputDatasetId", predicate: "inputDatasetId = {id}", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDatasetObjectsTran body." },
      { name: "core.Pipeline", scopeColumn: "pipelineId", predicate: "pipelineId IN (SELECT pipelineId FROM [core].[Pipeline] WHERE datasetId IN ( {id} ) )", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.DatasetMappingColumn", scopeColumn: "datasetMappingId", predicate: "datasetMappingId IN (SELECT datasetMappingId FROM [core].[DatasetMapping] WHERE datasetId_Left IN ( {id}))", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleColumn", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[DatasetColumn] p WHERE p.datasetColumnId = [core].[RuleColumn].inputDatasetColumnId AND p.datasetId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDatasetObjectsTran body." },
      { name: "core.RuleCondition", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[DatasetColumn] p WHERE p.datasetColumnId = [core].[RuleCondition].inputDatasetColumnId AND p.datasetId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDatasetObjectsTran body." },
      { name: "core.RuleLink", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[DatasetColumn] p WHERE p.datasetColumnId = [core].[RuleLink].outputDatasetColumnId AND p.datasetId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDatasetObjectsTran body." },
      { name: "core.Step", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[Pipeline] p WHERE p.pipelineId = [core].[Step].pipelineId AND p.datasetId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDatasetObjectsTran body." },
      { name: "core.Activity", scopeColumn: "pipelineId", predicate: "pipelineId IN (SELECT pipelineId FROM [core].[Pipeline] WHERE datasetId IN ( {id} ) )", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.RuleConditionValue", scopeColumn: null, predicate: "EXISTS (SELECT 1 FROM [core].[RuleCondition] p INNER JOIN [core].[DatasetColumn] _p1 ON _p1.datasetColumnId = p.inputDatasetColumnId WHERE p.ruleConditionId = [core].[RuleConditionValue].ruleConditionId AND _p1.datasetId = {id})", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncDatasetObjectsTran body." }
    ],
    executionOrder: ["core.Activity", "core.Pipeline", "core.DatasetMappingColumn", "core.DatasetMapping", "core.DatasetColumn", "core.Dataset", "core.Rule", "core.RuleColumn", "core.RuleCondition", "core.RuleLink", "core.Step", "core.RuleConditionValue"],
    reverseOrder: ["core.RuleConditionValue", "core.Step", "core.RuleLink", "core.RuleCondition", "core.RuleColumn", "core.Rule", "core.Dataset", "core.DatasetColumn", "core.DatasetMapping", "core.DatasetMappingColumn", "core.Pipeline", "core.Activity"],
  },
  {
    id: "pipelineActivity",
    displayName: "Pipeline & Activities",
    rootTable: "core.Pipeline",
    idColumn: "pipelineId",
    labelColumn: "name",
    selfJoinColumn: null,
    pipelineId: 798,
    pipelineName: "Synchronize Pipeline And Activities Transaction",
    entrySproc: "core.uspSyncPipelineObjectsTran",
    reviewStatus: "legacy-review-required",
    tables: [
      { name: "core.Pipeline", scopeColumn: "pipelineId", predicate: "pipelineId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false },
      { name: "core.Step", scopeColumn: "pipelineId", predicate: "pipelineId = {id}", source: "fk-only", verified: false, groundedByPipeline: false, enabledByDefault: false, userControllable: true, note: "Predicate inferred from FK graph. Verify against core.uspSyncPipelineObjectsTran body." },
      { name: "core.Activity", scopeColumn: "pipelineId", predicate: "pipelineId = {id}", source: "fk+pipeline", verified: true, groundedByPipeline: true, enabledByDefault: true, userControllable: false }
    ],
    executionOrder: ["core.Activity", "core.Pipeline", "core.Step"],
    reverseOrder: ["core.Step", "core.Pipeline", "core.Activity"],
  },
]

main().catch((error) => {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const recipeOutputPath = resolve(ROOT, options.recipesOut)
  const definitionsDir = resolve(ROOT, options.definitionsDir)

  ensureCanWrite(recipeOutputPath, options.force)
  if (!options.recipesOnly) {
    for (const entity of BOOTSTRAP_ENTITIES) {
      ensureCanWrite(resolve(definitionsDir, `${entity.id}.json`), options.force)
    }
  }

  const pool = await connectMssql(options.connection)
  try {
    const evidence = await loadPipelineEvidence(pool)
    validatePipelineEvidence(evidence)

    const generatedAt = new Date().toISOString()
    const introspectedFrom = formatIntrospectedFrom(pool.config)
    const bundle = buildRecipeBundle(generatedAt, introspectedFrom)

    mkdirSync(dirname(recipeOutputPath), { recursive: true })
    writeFileSync(recipeOutputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8")
    console.log(`Wrote legacy recipe bundle to ${relative(ROOT, recipeOutputPath)}`)

    if (!options.recipesOnly) {
      const flowTemplateCatalog = loadFlowTemplateCatalog()
      mkdirSync(definitionsDir, { recursive: true })
      for (const entity of BOOTSTRAP_ENTITIES) {
        const definition = buildAuthoredSyncDefinition(entity, bundle.generatedAt, relative(ROOT, recipeOutputPath), flowTemplateCatalog)
        const outputPath = resolve(definitionsDir, `${entity.id}.json`)
        writeFileSync(outputPath, `${JSON.stringify(definition, null, 2)}\n`, "utf-8")
        console.log(`Wrote sync definition to ${relative(ROOT, outputPath)}`)
      }
    }
  } finally {
    await pool.close()
  }
}

function parseArgs(argv) {
  const options = {
    connection: null,
    recipesOut: DEFAULT_RECIPES_OUT,
    definitionsDir: DEFAULT_DEFINITIONS_DIR,
    force: false,
    recipesOnly: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case "--connection":
        options.connection = argv[++index] ?? null
        break
      case "--recipes-out":
        options.recipesOut = argv[++index] ?? options.recipesOut
        break
      case "--definitions-dir":
        options.definitionsDir = argv[++index] ?? options.definitionsDir
        break
      case "--recipes-only":
        options.recipesOnly = true
        break
      case "--force":
        options.force = true
        break
      default:
        fail(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function ensureCanWrite(path, force) {
  if (existsSync(path) && !force) {
    fail(`Refusing to overwrite existing file without --force: ${relative(ROOT, path)}`)
  }
}

function fail(message) {
  console.error(`ERROR ${message}`)
  process.exit(1)
}

function parseMssqlConfigs() {
  const databasesJson = process.env["MSSQL_DATABASES"]
  if (databasesJson) {
    const raw = JSON.parse(databasesJson)
    if (!Array.isArray(raw) || raw.length === 0) fail("MSSQL_DATABASES must be a non-empty JSON array.")
    return raw.map((entry) => ({
      name: entry.name,
      config: {
        server: entry.host,
        port: entry.port ?? 1433,
        user: entry.user ?? "sa",
        password: entry.password ?? "",
        database: entry.database ?? "master",
        domain: entry.domain,
        options: {
          encrypt: entry.encrypt !== false,
          trustServerCertificate: entry.trustServerCertificate !== false,
        },
      },
    }))
  }

  const server = process.env["MSSQL_HOST"] || process.env["MSSQL_SERVER"]
  if (!server) {
    fail("MSSQL not configured. Set MSSQL_DATABASES or MSSQL_HOST/MSSQL_SERVER first.")
  }
  return [{
    name: "default",
    config: {
      server,
      port: Number(process.env["MSSQL_PORT"] ?? 1433),
      user: process.env["MSSQL_USER"] ?? "sa",
      password: process.env["MSSQL_PASSWORD"] ?? "",
      database: process.env["MSSQL_DATABASE"] ?? "master",
      domain: process.env["MSSQL_DOMAIN"] || undefined,
      options: {
        encrypt: process.env["MSSQL_ENCRYPT"] !== "false",
        trustServerCertificate: process.env["MSSQL_TRUST_CERT"] !== "false",
      },
    },
  }]
}

async function connectMssql(connectionName) {
  const configs = parseMssqlConfigs()
  const defaultName = process.env["MSSQL_DEFAULT_CONNECTION"] ?? configs[0].name
  const selected = configs.find((entry) => entry.name === (connectionName ?? defaultName))
  if (!selected) {
    fail(`Unknown MSSQL connection ${connectionName ?? defaultName}. Available: ${configs.map((entry) => entry.name).join(", ")}`)
  }
  const pool = new sql.ConnectionPool({
    ...selected.config,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      ...(selected.config.options ?? {}),
    },
    requestTimeout: 120_000,
    connectionTimeout: 15_000,
  })
  await pool.connect()
  return pool
}

async function loadPipelineEvidence(pool) {
  const pipelineIds = BOOTSTRAP_ENTITIES.map((entity) => entity.pipelineId).join(", ")
  const pipelines = await pool.request().query(`
    SELECT pipelineId, name
    FROM core.Pipeline
    WHERE pipelineId IN (${pipelineIds})
  `)
  const activities = await pool.request().query(`
    SELECT
      a.pipelineId,
      a.sequence,
      a.name AS activityName,
      JSON_VALUE(a.properties, '$.storedProcedure') AS storedProcedure
    FROM core.Activity AS a
    WHERE a.pipelineId IN (${pipelineIds})
      AND JSON_VALUE(a.properties, '$.storedProcedure') IS NOT NULL
    ORDER BY a.pipelineId, a.sequence
  `)
  const sprocDefinitions = new Map()
  for (const entity of BOOTSTRAP_ENTITIES) {
    const definition = await pool.request()
      .input("sproc", sql.NVarChar, entity.entrySproc)
      .query("SELECT OBJECT_DEFINITION(OBJECT_ID(@sproc)) AS definition")
    sprocDefinitions.set(entity.entrySproc, definition.recordset[0]?.definition ?? null)
  }
  return {
    pipelines: pipelines.recordset,
    activities: activities.recordset,
    sprocDefinitions,
  }
}

function validatePipelineEvidence(evidence) {
  for (const entity of BOOTSTRAP_ENTITIES) {
    const pipeline = evidence.pipelines.find((row) => Number(row.pipelineId) === entity.pipelineId)
    if (!pipeline) fail(`Pipeline ${entity.pipelineId} not found in core.Pipeline.`)
    if (pipeline.name !== entity.pipelineName) {
      fail(`Pipeline ${entity.pipelineId} name mismatch: expected "${entity.pipelineName}", got "${pipeline.name}".`)
    }
    const activity = evidence.activities.find((row) => Number(row.pipelineId) === entity.pipelineId && row.storedProcedure === entity.entrySproc)
    if (!activity) {
      fail(`Pipeline ${entity.pipelineId} does not have an activity with storedProcedure ${entity.entrySproc}.`)
    }
    const sprocBody = evidence.sprocDefinitions.get(entity.entrySproc)
    if (typeof sprocBody !== "string" || !sprocBody.includes("uspSyncObjectTran")) {
      fail(`Stored procedure ${entity.entrySproc} does not appear to call uspSyncObjectTran.`)
    }
  }
}

function formatIntrospectedFrom(config) {
  return `${config.server}/${config.config?.database ?? config.database ?? "master"}`
}

function buildRecipeBundle(generatedAt, introspectedFrom) {
  const recipes = Object.fromEntries(BOOTSTRAP_ENTITIES.map((entity) => [entity.id, {
    entityType: entity.id,
    displayName: entity.displayName,
    rootTable: entity.rootTable,
    rootKeyColumn: entity.idColumn,
    rootNameColumn: entity.labelColumn,
    legacyPipelineId: entity.pipelineId,
    legacyEntrySproc: entity.entrySproc,
    tables: entity.tables.map((table) => ({ ...table })),
    executionOrder: [...entity.executionOrder],
    reverseOrder: [...entity.reverseOrder],
    discrepancies: [],
    generatedAt,
  }]))
  return {
    version: 1,
    generatedAt,
    introspectedFrom,
    recipes,
  }
}

function loadFlowTemplateCatalog() {
  const path = resolve(ROOT, "deploy/sync/flow-templates.json")
  const parsed = JSON.parse(readFileSync(path, "utf-8"))
  if (parsed.version !== 1 || !parsed.flowTemplates) {
    fail("deploy/sync/flow-templates.json is invalid.")
  }
  return parsed.flowTemplates
}

function defaultFlowTemplateId(entityId, flowTemplates) {
  return entityId in flowTemplates ? entityId : "metadata-only"
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function buildAuthoredSyncDefinition(entity, generatedAt, sourceArtifact, flowTemplates) {
  const flowTemplateId = defaultFlowTemplateId(entity.id, flowTemplates)
  const reviewNote = entity.reviewStatus === "reviewed"
    ? "Legacy pipeline-derived tables were verified during migration review."
    : `${entity.displayName} still contains inferred legacy scope that requires review.`

  return {
    schemaVersion: 1,
    id: entity.id,
    displayName: entity.displayName,
    description: `${entity.displayName} sync definition migrated from legacy recipe bundle.`,
    rootTable: entity.rootTable,
    idColumn: entity.idColumn,
    labelColumn: entity.labelColumn,
    selfJoinColumn: entity.selfJoinColumn,
    legacy: {
      pipelineId: entity.pipelineId,
      entrySproc: entity.entrySproc,
    },
    governance: {
      approvalPolicyId: null,
      freezeWindowIds: [],
      riskMultiplier: 1,
    },
    strategy: {
      strategyId: "mymi-scd2",
      strategyVersion: "latest",
    },
    bindings: {
      serviceProfileRef: "default",
      environmentPolicyRef: "default",
    },
    ownership: {
      team: "sync-platform",
      owner: null,
      reviewStatus: entity.reviewStatus,
      notes: [
        "Bootstrapped from legacy sync-recipes.json.",
        reviewNote,
      ],
    },
    metadata: {
      tables: entity.tables.map((table) => ({ ...table })),
      executionOrder: [...entity.executionOrder],
      reverseOrder: [...entity.reverseOrder],
      discrepancies: [],
    },
    executionFlow: {
      steps: clone(flowTemplates[flowTemplateId].steps),
    },
    provenance: {
      kind: "legacy-migration",
      sourceArtifact,
      sourceVersion: generatedAt,
    },
  }
}