import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")
const DEFINITIONS_DIR = resolve(ROOT, "sync-definitions", "entities")
const PUBLISHED_DIR = resolve(ROOT, "sync-definitions", "published")
const PUBLISHED_BUNDLE = resolve(PUBLISHED_DIR, "definitions.bundle.json")
const SOURCE_BUNDLE = resolve(ROOT, "deploy", "mssql", "sync-recipes.json")
const OUTPUT_BUNDLE = SOURCE_BUNDLE

const FLOW_PRESETS = {
  contract: [
    step("audit-check", "pre-transaction", "auditCheck", "Audit check", "Validate target state before contract sync.", { auditObjectType: "Contract" }),
    step("target-lock", "pre-transaction", "targetLock", "Target lock", "Lock the target contract deployment window."),
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected contract scope."),
    step("pipeline-register", "post-metadata", "pipelineRegister", "Pipeline register", "Register affected pipelines with the target agent service.", { subjectRef: "contractPipelineId" }),
    step("contract-undeploy", "post-metadata", "contractUndeploy", "Contract undeploy", "Undeploy the target contract before redeployment."),
    step("contract-unlock-after-undeploy", "post-metadata", "targetUnlock", "Unlock after undeploy", "Unlock the contract after undeploy."),
    step("audit-check-2", "post-metadata", "auditCheck", "Pre-deploy audit check", "Run a second contract audit check before deployment.", { auditObjectType: "Contract" }),
    step("contract-lock-for-deploy", "post-metadata", "targetLock", "Lock for deploy", "Lock the contract for deployment."),
    step("contract-pre-script", "post-metadata", "contractPreScript", "Pre-deploy script", "Run contract pre-deployment scripts."),
    step("contract-create-dataset-stage", "post-metadata", "contractCreateStageDataset", "Create stage dataset", "Create the stage dataset."),
    step("contract-create-dataset-archive", "post-metadata", "contractCreateArchiveDataset", "Create archive dataset", "Create the archive dataset."),
    step("contract-create-dataset-list", "post-metadata", "contractCreateListDataset", "Create list dataset", "Create the list dataset."),
    step("contract-create-dataset-dim", "post-metadata", "contractCreateDimDataset", "Create dim dataset", "Create the dimension dataset."),
    step("contract-create-dataset-fact", "post-metadata", "contractCreateFactDataset", "Create fact dataset", "Create the fact dataset."),
    step("contract-create-fks", "post-metadata", "contractCreateDatasetFks", "Create dataset FKs", "Reconcile contract dataset foreign keys."),
    step("contract-deploy-etl", "post-metadata", "contractDeployEtl", "Deploy ETL", "Deploy ETL custom transformations."),
    step("contract-deploy-routine", "post-metadata", "contractDeployRoutine", "Deploy routines", "Deploy contract routines."),
    step("contract-post-script", "post-metadata", "contractPostScript", "Post-deploy script", "Run contract post-deployment scripts."),
    step("contract-unlock-after-deploy", "post-metadata", "targetUnlock", "Unlock after deploy", "Unlock the contract after deployment."),
    step("set-sync-date", "post-metadata", "syncDate", "Sync date", "Stamp the contract sync date.", { auditObjectType: "Contract" }),
    step("set-deploy-date", "post-metadata", "deployDate", "Deploy date", "Stamp the contract deploy date.", { auditObjectType: "Contract" }),
  ],
  dataset: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected dataset scope."),
    step("dataset-deploy", "post-metadata", "datasetDeploy", "Dataset deploy", "Deploy the dataset using the target ETL service."),
    step("sync-date", "post-metadata", "syncDate", "Sync date", "Stamp the dataset sync date after deployment.", { auditObjectType: "Dataset" }),
  ],
  rule: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected rule scope."),
    step("dataset-deploy", "post-metadata", "datasetDeploy", "Dataset deploy", "Deploy datasets required by the rule on the target ETL service.", { subjectRef: "ruleInputDatasetId" }),
    step("rules-deploy", "post-metadata", "rulesDeploy", "Rules deploy", "Deploy the rule package on the target ETL service."),
    step("handle-dependencies", "post-metadata", "handleDependencies", "Handle dependencies", "Refresh direct dependency state after rule deployment.", { objectName: "rule" }),
    step("sync-date", "post-metadata", "syncDate", "Sync date", "Stamp the rule sync date.", { auditObjectType: "Rule" }),
    step("deploy-date", "post-metadata", "deployDate", "Deploy date", "Stamp the rule deploy date.", { auditObjectType: "Rule" }),
  ],
  pipelineActivity: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected pipeline activity scope."),
    step("pipeline-register", "post-metadata", "pipelineRegister", "Pipeline register", "Register the target pipeline with the agent service."),
  ],
  gateMetadata: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected gate metadata scope."),
    step("meta-refresh", "post-metadata", "metaRefresh", "Meta refresh", "Refresh target gate metadata."),
    step("pipeline-start", "post-metadata", "pipelineStart", "Pipeline start", "Start the downstream gate refresh pipeline.", { pipelineName: "All Lists content item population" }),
  ],
  content: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected content scope."),
    step("handle-dependencies", "post-metadata", "handleDependencies", "Handle dependencies", "Refresh downstream content dependency state.", { objectName: "content" }),
  ],
}

const POST_METADATA_KIND_MAP = new Map([
  ["contractDeploy", "contractDeploy"],
  ["datasetDeploy", "datasetDeploy"],
  ["rulesDeploy", "rulesDeploy"],
  ["pipelineRegister", "pipelineRegister"],
  ["metaRefresh", "metaRefresh"],
  ["pipelineStart", "pipelineStart"],
  ["handleDependencies", "handleDependencies"],
  ["syncDate", "syncDate"],
  ["deployDate", "deployDate"],
])

main()

function main() {
  const args = new Set(process.argv.slice(2))
  const shouldBootstrap = args.has("--bootstrap-from-bundle")
  const shouldWrite = args.has("--write")
  const shouldCheck = args.has("--check")

  if (shouldBootstrap) bootstrapDefinitionsFromBundle()

  const definitions = loadDefinitions()
  const result = validateDefinitions(definitions)
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`ERROR ${error}`)
    process.exitCode = 1
    return
  }
  for (const warning of result.warnings) console.warn(`WARN ${warning}`)

  const bundle = compileBundle(definitions)
  const published = compilePublishedBundle(definitions)
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`
  const publishedSerialized = `${JSON.stringify(published, null, 2)}\n`

  if (shouldWrite) {
    mkdirSync(PUBLISHED_DIR, { recursive: true })
    writeFileSync(PUBLISHED_BUNDLE, publishedSerialized)
    writeFileSync(OUTPUT_BUNDLE, serialized)
    console.log(`Wrote published definition bundle to ${PUBLISHED_BUNDLE}`)
    console.log(`Wrote compatibility bundle to ${OUTPUT_BUNDLE}`)
  } else if (shouldCheck) {
    const currentPublished = JSON.parse(readFileSync(PUBLISHED_BUNDLE, "utf-8"))
    if (JSON.stringify(normalizePublishedBundleForCheck(currentPublished)) !== JSON.stringify(normalizePublishedBundleForCheck(published))) {
      console.error(`ERROR published definition bundle is stale: ${PUBLISHED_BUNDLE}`)
      process.exitCode = 1
      return
    }
    const current = JSON.parse(readFileSync(OUTPUT_BUNDLE, "utf-8"))
    if (JSON.stringify(normalizeBundleForCheck(current)) !== JSON.stringify(normalizeBundleForCheck(bundle))) {
      console.error(`ERROR compiled bundle is stale: ${OUTPUT_BUNDLE}`)
      process.exitCode = 1
      return
    }
    console.log(`Published definition bundle is up to date: ${PUBLISHED_BUNDLE}`)
    console.log(`Compatibility bundle is up to date: ${OUTPUT_BUNDLE}`)
  } else {
    process.stdout.write(publishedSerialized)
  }
}

function step(id, phase, kind, title, description, extra = {}) {
  return { id, phase, kind, title, description, ...extra }
}

function bootstrapDefinitionsFromBundle() {
  mkdirSync(DEFINITIONS_DIR, { recursive: true })
  const raw = JSON.parse(readFileSync(SOURCE_BUNDLE, "utf-8"))
  const recipes = raw.recipes ?? {}
  const entityIds = Object.keys(recipes).sort()
  for (const entityId of entityIds) {
    const recipe = recipes[entityId]
    if (!recipe) continue
    const filePath = resolve(DEFINITIONS_DIR, `${entityId}.json`)
    const definition = {
      schemaVersion: 1,
      id: entityId,
      displayName: recipe.displayName,
      description: `${recipe.displayName} sync definition migrated from legacy recipe bundle.`,
      rootTable: recipe.rootTable,
      idColumn: recipe.rootKeyColumn,
      labelColumn: recipe.rootNameColumn ?? null,
      selfJoinColumn: recipe.selfJoinColumn ?? null,
      legacy: {
        pipelineId: recipe.legacyPipelineId ?? null,
        entrySproc: recipe.legacyEntrySproc ?? null,
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
        reviewStatus: "legacy-review-required",
        notes: [
          "Bootstrapped from legacy sync-recipes.json.",
          "Review table scope, provenance, and execution ownership before treating as fully curated.",
        ],
      },
      metadata: {
        tables: recipe.tables,
        executionOrder: recipe.executionOrder,
        reverseOrder: recipe.reverseOrder,
        discrepancies: recipe.discrepancies ?? [],
      },
      executionFlow: {
        steps: FLOW_PRESETS[entityId] ?? [
          step("metadata-sync", "metadata", "metadataSync", "Metadata sync", `Apply transactional metadata changes for ${entityId}.`),
        ],
      },
      provenance: {
        kind: "legacy-migration",
        sourceArtifact: "deploy/mssql/sync-recipes.json",
        sourceVersion: raw.generatedAt ?? null,
      },
    }
    writeFileSync(filePath, `${JSON.stringify(definition, null, 2)}\n`)
  }
  console.log(`Bootstrapped ${entityIds.length} sync definition file(s) into ${DEFINITIONS_DIR}`)
}

function loadDefinitions() {
  mkdirSync(DEFINITIONS_DIR, { recursive: true })
  return readdirSync(DEFINITIONS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const filePath = resolve(DEFINITIONS_DIR, name)
      const parsed = JSON.parse(readFileSync(filePath, "utf-8"))
      return { filePath, definition: parsed }
    })
}

function validateDefinitions(items) {
  const errors = []
  const warnings = []
  const ids = new Set()

  for (const { filePath, definition } of items) {
    if (definition.schemaVersion !== 1) errors.push(`${filePath}: schemaVersion must be 1`)
    if (!isNonEmptyString(definition.id)) errors.push(`${filePath}: id is required`)
    if (definition.id && ids.has(definition.id)) errors.push(`${filePath}: duplicate id ${definition.id}`)
    ids.add(definition.id)
    if (!isNonEmptyString(definition.displayName)) errors.push(`${filePath}: displayName is required`)
    if (!isNonEmptyString(definition.rootTable)) errors.push(`${filePath}: rootTable is required`)
    if (!isNonEmptyString(definition.idColumn)) errors.push(`${filePath}: idColumn is required`)
    if (!Array.isArray(definition.metadata?.tables) || definition.metadata.tables.length === 0) errors.push(`${filePath}: metadata.tables must be a non-empty array`)
    if (!Array.isArray(definition.metadata?.executionOrder)) errors.push(`${filePath}: metadata.executionOrder must be an array`)
    if (!Array.isArray(definition.metadata?.reverseOrder)) errors.push(`${filePath}: metadata.reverseOrder must be an array`)
    if (!Array.isArray(definition.executionFlow?.steps) || definition.executionFlow.steps.length === 0) errors.push(`${filePath}: executionFlow.steps must be a non-empty array`)
    if (!Number.isFinite(definition.governance?.riskMultiplier) || definition.governance.riskMultiplier <= 0) errors.push(`${filePath}: governance.riskMultiplier must be > 0`)
    if (!isNonEmptyString(definition.ownership?.team)) errors.push(`${filePath}: ownership.team is required`)
    if (!["legacy-review-required", "reviewed"].includes(definition.ownership?.reviewStatus)) errors.push(`${filePath}: ownership.reviewStatus must be legacy-review-required or reviewed`)
    if (!Array.isArray(definition.ownership?.notes)) errors.push(`${filePath}: ownership.notes must be an array`)
    const tableNames = new Set()
    for (const table of definition.metadata?.tables ?? []) {
      if (!isNonEmptyString(table.name)) errors.push(`${filePath}: every metadata table must have a name`)
      if (tableNames.has(table.name)) errors.push(`${filePath}: duplicate metadata table ${table.name}`)
      tableNames.add(table.name)
      if (typeof table.predicate !== "string") errors.push(`${filePath}: table ${table.name} must define predicate`)
    }
    ensureSameMembers(filePath, "executionOrder", definition.metadata?.executionOrder ?? [], tableNames, errors)
    ensureSameMembers(filePath, "reverseOrder", definition.metadata?.reverseOrder ?? [], tableNames, errors)

    const flowIds = new Set()
    let metadataSyncCount = 0
    for (const stepDef of definition.executionFlow?.steps ?? []) {
      if (!isNonEmptyString(stepDef.id)) errors.push(`${filePath}: every execution step must have id`)
      if (flowIds.has(stepDef.id)) errors.push(`${filePath}: duplicate execution step ${stepDef.id}`)
      flowIds.add(stepDef.id)
      if (stepDef.kind === "metadataSync") metadataSyncCount++
      if (!isNonEmptyString(stepDef.phase)) errors.push(`${filePath}: execution step ${stepDef.id} must define phase`)
      if (!isNonEmptyString(stepDef.kind)) errors.push(`${filePath}: execution step ${stepDef.id} must define kind`)
    }
    if (metadataSyncCount !== 1) errors.push(`${filePath}: executionFlow must contain exactly one metadataSync step`)
    const unverified = (definition.metadata?.tables ?? []).filter((table) => table.verified === false)
    if (unverified.length > 0) warnings.push(`${filePath}: contains ${unverified.length} unverified table(s): ${unverified.map((table) => table.name).join(", ")}`)
  }

  return { errors, warnings }
}

function ensureSameMembers(filePath, label, orderedList, tableNames, errors) {
  const orderedSet = new Set(orderedList)
  for (const name of orderedList) {
    if (!tableNames.has(name)) errors.push(`${filePath}: ${label} references unknown table ${name}`)
  }
  for (const tableName of tableNames) {
    if (!orderedSet.has(tableName)) errors.push(`${filePath}: ${label} is missing table ${tableName}`)
  }
}

function compileBundle(items) {
  const generatedAt = new Date().toISOString()
  const recipes = {}
  for (const { definition } of items) {
    recipes[definition.id] = compileDefinition(definition, generatedAt)
  }
  return {
    version: 1,
    generatedAt,
    introspectedFrom: null,
    _comment: "Compiled from repo-authored sync definition files in sync-definitions/entities. Do not edit by hand.",
    recipes,
  }
}

function compilePublishedBundle(items) {
  const publishedAt = new Date().toISOString()
  const publishedVersion = publishedAt
  const definitions = {}
  for (const { definition } of items) {
    definitions[definition.id] = {
      ...definition,
      publishedAt,
      publishedVersion,
    }
  }
  return {
    version: 1,
    publishedAt,
    publishedVersion,
    definitions,
  }
}

function normalizeBundleForCheck(bundle) {
  const normalizedRecipes = {}
  for (const [entityId, recipe] of Object.entries(bundle.recipes ?? {})) {
    normalizedRecipes[entityId] = recipe
      ? { ...recipe, generatedAt: "<normalized>" }
      : recipe
  }
  return {
    ...bundle,
    generatedAt: "<normalized>",
    recipes: normalizedRecipes,
  }
}

function normalizePublishedBundleForCheck(bundle) {
  const normalizedDefinitions = {}
  for (const [entityId, definition] of Object.entries(bundle.definitions ?? {})) {
    normalizedDefinitions[entityId] = definition
      ? { ...definition, publishedAt: "<normalized>", publishedVersion: "<normalized>" }
      : definition
  }
  return {
    ...bundle,
    publishedAt: "<normalized>",
    publishedVersion: "<normalized>",
    definitions: normalizedDefinitions,
  }
}

function compileDefinition(definition, generatedAt) {
  const postMetadataActions = definition.executionFlow.steps
    .filter((entry) => entry.phase === "post-metadata" && POST_METADATA_KIND_MAP.has(entry.kind))
    .map((entry) => ({ kind: POST_METADATA_KIND_MAP.get(entry.kind) }))

  return {
    entityType: definition.id,
    displayName: definition.displayName,
    rootTable: definition.rootTable,
    rootKeyColumn: definition.idColumn,
    rootNameColumn: definition.labelColumn,
    selfJoinColumn: definition.selfJoinColumn,
    legacyPipelineId: definition.legacy.pipelineId,
    legacyEntrySproc: definition.legacy.entrySproc,
    tables: definition.metadata.tables,
    executionOrder: definition.metadata.executionOrder,
    reverseOrder: definition.metadata.reverseOrder,
    postMetadataActions,
    discrepancies: definition.metadata.discrepancies,
    generatedAt,
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
}