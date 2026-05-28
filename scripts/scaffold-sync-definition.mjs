import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { parseAllDocuments } from "yaml"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..")

const FLOW_PRESETS = {
  contract: [
    step("audit-check", "pre-transaction", "auditCheck", "Audit check", "Validate target state before contract sync."),
    step("target-lock", "pre-transaction", "targetLock", "Target lock", "Lock the target contract deployment window."),
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected contract scope."),
    step("pipeline-register", "post-metadata", "pipelineRegister", "Pipeline register", "Register affected pipelines with the target agent service."),
    step("contract-deploy", "post-metadata", "contractDeploy", "Contract deploy", "Run the contract deployment sequence on the target environment."),
  ],
  dataset: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected dataset scope."),
    step("dataset-deploy", "post-metadata", "datasetDeploy", "Dataset deploy", "Deploy the dataset using the target ETL service."),
    step("sync-date", "post-metadata", "syncDate", "Sync date", "Stamp the dataset sync date after deployment."),
  ],
  rule: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected rule scope."),
    step("dataset-deploy", "post-metadata", "datasetDeploy", "Dataset deploy", "Deploy datasets required by the rule on the target ETL service."),
    step("rules-deploy", "post-metadata", "rulesDeploy", "Rules deploy", "Deploy the rule package on the target ETL service."),
    step("handle-dependencies", "post-metadata", "handleDependencies", "Handle dependencies", "Refresh direct dependency state after rule deployment."),
    step("sync-date", "post-metadata", "syncDate", "Sync date", "Stamp the rule sync date."),
    step("deploy-date", "post-metadata", "deployDate", "Deploy date", "Stamp the rule deploy date."),
  ],
  pipelineActivity: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected pipeline activity scope."),
    step("pipeline-register", "post-metadata", "pipelineRegister", "Pipeline register", "Register the target pipeline with the agent service."),
  ],
  gateMetadata: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected gate metadata scope."),
    step("meta-refresh", "post-metadata", "metaRefresh", "Meta refresh", "Refresh target gate metadata."),
    step("pipeline-start", "post-metadata", "pipelineStart", "Pipeline start", "Start the downstream gate refresh pipeline."),
  ],
  content: [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected content scope."),
    step("handle-dependencies", "post-metadata", "handleDependencies", "Handle dependencies", "Refresh downstream content dependency state."),
  ],
  "metadata-only": [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected entity scope."),
  ],
}

main()

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.input) fail("Missing required --input <path>.")

  const inputPath = resolve(ROOT, options.input)
  const docs = loadYamlDocuments(inputPath)
  const entity = selectEntity(docs, options.entity)
  const flowPreset = options.flowPreset ?? (FLOW_PRESETS[entity.id] ? entity.id : "metadata-only")
  const scaffold = buildDefinitionScaffold(entity, {
    inputPath,
    flowPreset,
    serviceProfileRef: options.serviceProfileRef ?? "default",
    environmentPolicyRef: options.environmentPolicyRef ?? "default",
  })
  const serialized = `${JSON.stringify(scaffold, null, 2)}\n`

  if (options.write || options.output) {
    const outputPath = resolve(ROOT, options.output ?? `sync-definitions/entities/${entity.id}.json`)
    if (existsSync(outputPath) && !options.force) {
      fail(`Refusing to overwrite existing file without --force: ${relative(ROOT, outputPath)}`)
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, serialized)
    console.log(`Wrote scaffold to ${relative(ROOT, outputPath)}`)
    return
  }

  process.stdout.write(serialized)
}

function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
    entity: null,
    flowPreset: null,
    serviceProfileRef: null,
    environmentPolicyRef: null,
    write: false,
    force: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case "--input":
        options.input = argv[++index] ?? null
        break
      case "--output":
        options.output = argv[++index] ?? null
        break
      case "--entity":
        options.entity = argv[++index] ?? null
        break
      case "--flow-preset":
        options.flowPreset = argv[++index] ?? null
        break
      case "--service-profile":
        options.serviceProfileRef = argv[++index] ?? null
        break
      case "--environment-policy":
        options.environmentPolicyRef = argv[++index] ?? null
        break
      case "--write":
        options.write = true
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

function loadYamlDocuments(inputPath) {
  const text = readFileSync(inputPath, "utf-8")
  return parseAllDocuments(text, { strict: true })
    .filter((document) => document.contents !== null)
    .map((document) => document.toJSON())
}

function selectEntity(docs, entityId) {
  const items = docs.filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
  if (entityId) {
    const match = items.find((entry) => entry.id === entityId)
    if (!match) fail(`Entity \"${entityId}\" not found in YAML input.`)
    return match
  }
  if (items.length !== 1) {
    fail(`Input contains ${items.length} entities; choose one with --entity <id>.`)
  }
  return items[0]
}

function buildDefinitionScaffold(entity, options) {
  if (!FLOW_PRESETS[options.flowPreset]) {
    fail(`Unknown --flow-preset \"${options.flowPreset}\". Available presets: ${Object.keys(FLOW_PRESETS).sort().join(", ")}`)
  }

  const tables = [...(Array.isArray(entity.tables) ? entity.tables : [])]
    .sort((left, right) => Number(left.executionOrder ?? 0) - Number(right.executionOrder ?? 0))
    .map((table) => projectMetadataTable(entity, table))
  const executionOrder = tables.map((table) => table.name)
  const reverseOrder = Array.isArray(entity.reverseOrder) && entity.reverseOrder.length > 0
    ? entity.reverseOrder.map(String)
    : [...executionOrder].reverse()

  return {
    schemaVersion: 1,
    id: String(entity.id),
    displayName: String(entity.displayName ?? entity.id),
    description: typeof entity.description === "string" && entity.description.trim().length > 0
      ? entity.description
      : `${String(entity.displayName ?? entity.id)} sync definition scaffolded from entity-registry YAML.`,
    rootTable: String(entity.rootTable),
    idColumn: String(entity.idColumn),
    labelColumn: typeof entity.labelColumn === "string" ? entity.labelColumn : null,
    selfJoinColumn: typeof entity.selfJoinColumn === "string" ? entity.selfJoinColumn : null,
    legacy: {
      pipelineId: extractLegacyPipelineId(entity.provenance),
      entrySproc: typeof entity.legacyEntrySproc === "string" ? entity.legacyEntrySproc : null,
    },
    governance: {
      approvalPolicyId: entity.policies?.approvalPolicyId ?? null,
      freezeWindowIds: Array.isArray(entity.policies?.freezeWindowIds) ? entity.policies.freezeWindowIds.map(String) : [],
      riskMultiplier: Number(entity.policies?.riskMultiplier ?? 1),
    },
    strategy: {
      strategyId: String(entity.scd2?.strategyId ?? "mymi-scd2"),
      strategyVersion: entity.scd2?.strategyVersion ?? "latest",
    },
    bindings: {
      serviceProfileRef: options.serviceProfileRef,
      environmentPolicyRef: options.environmentPolicyRef,
    },
    ownership: {
      team: "sync-platform",
      owner: null,
      reviewStatus: "legacy-review-required",
      notes: [
        "Scaffolded from Entity Registry or YAML draft.",
        "Assign an explicit owner and complete review before compile/publish.",
      ],
    },
    metadata: {
      tables,
      executionOrder,
      reverseOrder,
      discrepancies: Array.isArray(entity.discrepancies) ? entity.discrepancies.map(String) : [],
    },
    executionFlow: {
      steps: FLOW_PRESETS[options.flowPreset],
    },
    provenance: {
      kind: "entity-registry-yaml",
      sourceArtifact: relative(ROOT, options.inputPath),
      sourceVersion: entity.__meta?.version ?? entity.version ?? null,
    },
  }
}

function projectMetadataTable(entity, table) {
  const scopeColumn = typeof table.scopeColumn === "string"
    ? table.scopeColumn
    : table.scope?.kind === "rootPk"
      ? table.scope.column
      : null
  const projected = {
    name: String(table.name),
    scopeColumn,
    predicate: projectPredicate(entity, table),
    source: typeof table.source === "string" ? table.source : "manual",
    verified: Boolean(table.verified),
    groundedByPipeline: typeof table.groundedByPipeline === "boolean" ? table.groundedByPipeline : false,
    enabledByDefault: typeof table.enabledByDefault === "boolean" ? table.enabledByDefault : true,
    userControllable: typeof table.userControllable === "boolean" ? table.userControllable : false,
  }
  if (typeof table.note === "string" && table.note.trim().length > 0) projected.note = table.note
  return projected
}

function projectPredicate(entity, table) {
  const scope = table.scope
  if (!scope || typeof scope !== "object" || typeof scope.kind !== "string") {
    fail(`Table ${String(table.name)} is missing a valid scope definition.`)
  }
  const hasSelfJoin = typeof entity.selfJoinColumn === "string" && entity.selfJoinColumn.trim().length > 0
  switch (scope.kind) {
    case "rootPk": {
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `${quoteIdentifier(scope.column)}${op}`
    }
    case "sql":
      return String(scope.predicate)
    case "fkPath": {
      const through = Array.isArray(scope.through) ? scope.through : []
      if (through.length === 0) fail(`Table ${String(table.name)} has fkPath scope with no hops.`)
      const aliases = through.map((_, index) => `h${index}`)
      const joins = []
      for (let index = 0; index < through.length; index++) {
        const hop = through[index]
        const alias = aliases[index]
        if (index === 0) {
          joins.push(`FROM ${hop.table} AS ${alias}`)
        } else {
          const previousAlias = aliases[index - 1]
          const previousHop = through[index - 1]
          joins.push(`JOIN ${hop.table} AS ${alias} ON ${alias}.${quoteIdentifier(hop.toColumn)} = ${previousAlias}.${quoteIdentifier(previousHop.fromColumn)}`)
        }
      }
      const firstHop = through[0]
      const lastHop = through[through.length - 1]
      const lastAlias = aliases[aliases.length - 1]
      const op = hasSelfJoin ? " IN ({ids})" : " = {id}"
      return `EXISTS (SELECT 1 ${joins.join(" ")} WHERE ${aliases[0]}.${quoteIdentifier(firstHop.toColumn)} = ${quoteRootRef(table.name, firstHop.toColumn)} AND ${lastAlias}.${quoteIdentifier(lastHop.fromColumn)}${op})`
    }
    default:
      fail(`Unsupported scope kind \"${scope.kind}\" for table ${String(table.name)}.`)
  }
}

function quoteIdentifier(identifier) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : `[${identifier}]`
}

function quoteRootRef(tableName, column) {
  return `${tableName}.${quoteIdentifier(column)}`
}

function extractLegacyPipelineId(provenance) {
  if (!provenance || typeof provenance !== "object") return null
  return provenance.kind === "legacy-migration" && Number.isInteger(provenance.legacyPipelineId)
    ? provenance.legacyPipelineId
    : null
}

function step(id, phase, kind, title, description) {
  return { id, phase, kind, title, description }
}

function fail(message) {
  console.error(`ERROR ${message}`)
  process.exit(1)
}