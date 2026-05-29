import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type {
    AuthoredSyncDefinition,
    EntityRegistrySyncFlowPreset,
    PublishedSyncDefinition,
  SyncDefinitionRuntimeOptions,
} from "@mia/shared-types"
import type { EntityDefinition } from "@mia/sync"

import * as db from "../adapters/persistence/sqlite.js"

const DEFAULT_TENANT_ID = "_default"
const PUBLISHED_BUNDLE_PATH = "sync-definitions/published/definitions.bundle.json"
const AUTHORED_DEFINITIONS_DIR = "sync-definitions/entities"

const FLOW_PRESETS: Record<EntityRegistrySyncFlowPreset, AuthoredSyncDefinition["executionFlow"]["steps"]> = {
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
  "metadata-only": [
    step("metadata-sync", "metadata", "metadataSync", "Metadata sync", "Apply transactional metadata changes for the selected entity scope."),
  ],
}

const FLOW_PRESET_DETAILS: Record<EntityRegistrySyncFlowPreset, { label: string; description: string }> = {
  contract: {
    label: "Contract deploy",
    description: "Metadata sync plus full contract deployment, ETL, routines, and deploy stamps.",
  },
  dataset: {
    label: "Dataset deploy",
    description: "Metadata sync followed by dataset deployment on the target ETL service.",
  },
  rule: {
    label: "Rule deploy",
    description: "Metadata sync, dependent dataset deploy, rule deploy, and dependency refresh.",
  },
  pipelineActivity: {
    label: "Pipeline register",
    description: "Metadata sync followed by registering the target pipeline with the agent service.",
  },
  gateMetadata: {
    label: "Gate refresh",
    description: "Metadata sync followed by gate metadata refresh and downstream pipeline start.",
  },
  content: {
    label: "Content dependencies",
    description: "Metadata sync followed by downstream dependency refresh for content entities.",
  },
  "metadata-only": {
    label: "Metadata only",
    description: "Only apply metadata changes; do not trigger downstream deploy or refresh steps.",
  },
}

const SERVICE_PROFILE_OPTIONS: SyncDefinitionRuntimeOptions["serviceProfiles"] = [
  {
    id: "default",
    label: "Default service routing",
    description: "Use the standard environment-resolved agent, ETL, and gate service endpoints.",
  },
]

const ENVIRONMENT_POLICY_OPTIONS: SyncDefinitionRuntimeOptions["environmentPolicies"] = [
  {
    id: "default",
    label: "Default environment rules",
    description: "Apply the standard environment access mode, allowlist, and target checks.",
  },
]

export interface SyncDefinitionAdminItem {
  id: string
  displayName: string
  entityVersion: number
  tableCount: number
  flowPreset: EntityRegistrySyncFlowPreset
  serviceProfileRef: string
  environmentPolicyRef: string
  ownershipTeam: string
  ownershipOwner: string | null
  reviewStatus: "legacy-review-required" | "reviewed"
  ownershipNotes: string[]
  updatedAt: string
  updatedBy: string | null
  publishedVersion: string | null
  publishedAt: string | null
}

export function listSyncDefinitionRuntimeOptions(): SyncDefinitionRuntimeOptions {
  return {
    flowPresets: (Object.keys(FLOW_PRESET_DETAILS) as EntityRegistrySyncFlowPreset[]).map((id) => ({
      id,
      label: FLOW_PRESET_DETAILS[id].label,
      description: FLOW_PRESET_DETAILS[id].description,
    })),
    serviceProfiles: SERVICE_PROFILE_OPTIONS,
    environmentPolicies: ENVIRONMENT_POLICY_OPTIONS,
  }
}

interface PersistedPublishedBundle {
  version: 1
  publishedAt: string
  publishedVersion: string
  definitions: Record<string, PublishedSyncDefinition | null>
}

function step(
  id: string,
  phase: AuthoredSyncDefinition["executionFlow"]["steps"][number]["phase"],
  kind: AuthoredSyncDefinition["executionFlow"]["steps"][number]["kind"],
  title: string,
  description: string,
  extra: Partial<AuthoredSyncDefinition["executionFlow"]["steps"][number]> = {},
): AuthoredSyncDefinition["executionFlow"]["steps"][number] {
  return { id, phase, kind, title, description, ...extra }
}

function defaultFlowPreset(entityId: string): EntityRegistrySyncFlowPreset {
  return entityId in FLOW_PRESETS ? entityId as EntityRegistrySyncFlowPreset : "metadata-only"
}

function defaultConfigForEntity(entity: EntityDefinition): db.DbSyncDefinitionConfig {
  const now = new Date().toISOString()
  return {
    tenant_id: entity.tenantId,
    entity_id: entity.id,
    flow_preset: defaultFlowPreset(entity.id),
    service_profile_ref: "default",
    environment_policy_ref: "default",
    ownership_team: "sync-platform",
    ownership_owner: null,
    review_status: "legacy-review-required",
    ownership_notes_json: JSON.stringify([
      "Managed in DB via Entity Registry + Sync Admin.",
      "Review and publish after changing runtime bindings or flow preset.",
    ]),
    updated_at: now,
    updated_by: null,
  }
}

function inferFlowPreset(entityId: string, definition: Partial<AuthoredSyncDefinition>): EntityRegistrySyncFlowPreset {
  const kinds = (definition.executionFlow?.steps ?? []).map((step) => step.kind)
  for (const [preset, steps] of Object.entries(FLOW_PRESETS) as Array<[EntityRegistrySyncFlowPreset, AuthoredSyncDefinition["executionFlow"]["steps"]]>) {
    if (steps.map((step) => step.kind).join("|") === kinds.join("|")) return preset
  }
  return defaultFlowPreset(entityId)
}

function seedFromRepoDefinition(projectRoot: string, entity: EntityDefinition): db.DbSyncDefinitionConfig | null {
  const path = resolve(projectRoot, AUTHORED_DEFINITIONS_DIR, `${entity.id}.json`)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AuthoredSyncDefinition>
    const base = defaultConfigForEntity(entity)
    return {
      ...base,
      flow_preset: inferFlowPreset(entity.id, parsed),
      service_profile_ref: parsed.bindings?.serviceProfileRef ?? base.service_profile_ref,
      environment_policy_ref: parsed.bindings?.environmentPolicyRef ?? base.environment_policy_ref,
      ownership_team: parsed.ownership?.team ?? base.ownership_team,
      ownership_owner: parsed.ownership?.owner ?? base.ownership_owner,
      review_status: parsed.ownership?.reviewStatus ?? base.review_status,
      ownership_notes_json: JSON.stringify(parsed.ownership?.notes ?? JSON.parse(base.ownership_notes_json) as string[]),
    }
  } catch (error) {
    console.warn(`[sync-definitions] failed to seed config from ${path}:`, error instanceof Error ? error.message : error)
    return null
  }
}

function predicateForTable(entity: EntityDefinition, table: EntityDefinition["tables"][number]): string {
  if (table.scope?.kind === "sql" && typeof table.scope.predicate === "string") return table.scope.predicate
  if (table.scope?.kind === "rootPk") return `${table.scope.column}${entity.selfJoinColumn ? " IN ({ids})" : " = {id}"}`
  if (typeof table.scopeColumn === "string" && table.scopeColumn.trim().length > 0) return `${table.scopeColumn} = {id}`
  return `${entity.idColumn} = {id}`
}

function composeDefinition(
  entity: EntityDefinition,
  config: db.DbSyncDefinitionConfig,
  publishedAt: string,
  publishedVersion: string,
): PublishedSyncDefinition {
  const flowPreset = (config.flow_preset in FLOW_PRESETS ? config.flow_preset : defaultFlowPreset(entity.id)) as EntityRegistrySyncFlowPreset
  const executionOrder = entity.tables
    .slice()
    .sort((left, right) => Number(left.executionOrder ?? 0) - Number(right.executionOrder ?? 0))
    .map((table) => table.name)
  const reverseOrder = entity.reverseOrder.length > 0 ? entity.reverseOrder : [...executionOrder].reverse()

  return {
    schemaVersion: 1,
    id: entity.id,
    displayName: entity.displayName,
    description: entity.description,
    rootTable: entity.rootTable,
    idColumn: entity.idColumn,
    labelColumn: entity.labelColumn,
    selfJoinColumn: entity.selfJoinColumn,
    legacy: {
	      pipelineId: entity.provenance.kind === "legacy-migration" ? entity.provenance.legacyPipelineId : null,
      entrySproc: entity.legacyEntrySproc ?? null,
    },
    governance: {
      approvalPolicyId: entity.policies.approvalPolicyId,
      freezeWindowIds: entity.policies.freezeWindowIds,
      riskMultiplier: entity.policies.riskMultiplier,
    },
    strategy: {
      strategyId: entity.scd2.strategyId,
      strategyVersion: entity.scd2.strategyVersion,
    },
    bindings: {
      serviceProfileRef: config.service_profile_ref,
      environmentPolicyRef: config.environment_policy_ref,
    },
    ownership: {
      team: config.ownership_team,
      owner: config.ownership_owner,
      reviewStatus: config.review_status,
      notes: JSON.parse(config.ownership_notes_json) as string[],
    },
    metadata: {
      tables: entity.tables.map((table) => ({
        name: table.name,
        scopeColumn: table.scopeColumn,
        predicate: predicateForTable(entity, table),
        source: table.source ?? "manual",
        verified: Boolean(table.verified),
        groundedByPipeline: Boolean(table.groundedByPipeline),
        enabledByDefault: table.enabledByDefault ?? true,
        userControllable: table.userControllable ?? false,
        ...(table.note ? { note: table.note } : {}),
      })),
      executionOrder,
      reverseOrder,
      discrepancies: entity.discrepancies.map((note) => ({ table: entity.rootTable, kind: "drift", note })),
    },
    executionFlow: {
      steps: FLOW_PRESETS[flowPreset],
    },
    provenance: {
	      kind: entity.provenance.kind === "legacy-migration" ? "legacy-migration" : "manual",
      sourceArtifact: `entity-registry:${entity.tenantId}/${entity.id}`,
      sourceVersion: String(entity.version),
    },
    publishedAt,
    publishedVersion,
  }
}

function loadPublishedBundle(projectRoot: string): PersistedPublishedBundle | null {
  const path = resolve(projectRoot, PUBLISHED_BUNDLE_PATH)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PersistedPublishedBundle
  } catch {
    return null
  }
}

export function ensureSyncDefinitionConfigs(projectRoot: string, tenantId = DEFAULT_TENANT_ID): void {
  const entities = db.listEntityDefinitions(tenantId)
  if (entities.length === 0) return
  const existing = new Set(db.listSyncDefinitionConfigs(tenantId).map((row) => row.entity_id))
  for (const entity of entities) {
    if (existing.has(entity.id)) continue
    db.saveSyncDefinitionConfig(seedFromRepoDefinition(projectRoot, entity) ?? defaultConfigForEntity(entity))
  }
}

export function listSyncDefinitionAdminItems(projectRoot: string, tenantId = DEFAULT_TENANT_ID): SyncDefinitionAdminItem[] {
  ensureSyncDefinitionConfigs(projectRoot, tenantId)
  const entities = db.listEntityDefinitions(tenantId)
  const configs = new Map(db.listSyncDefinitionConfigs(tenantId).map((row) => [row.entity_id, row]))
  const published = loadPublishedBundle(projectRoot)
  return entities.map((entity) => {
    const config = configs.get(entity.id) ?? defaultConfigForEntity(entity)
    const publishedDefinition = published?.definitions?.[entity.id] ?? null
    return {
      id: entity.id,
      displayName: entity.displayName,
      entityVersion: entity.version,
      tableCount: entity.tables.length,
      flowPreset: (config.flow_preset in FLOW_PRESETS ? config.flow_preset : defaultFlowPreset(entity.id)) as EntityRegistrySyncFlowPreset,
      serviceProfileRef: config.service_profile_ref,
      environmentPolicyRef: config.environment_policy_ref,
      ownershipTeam: config.ownership_team,
      ownershipOwner: config.ownership_owner,
      reviewStatus: config.review_status,
      ownershipNotes: JSON.parse(config.ownership_notes_json) as string[],
      updatedAt: config.updated_at,
      updatedBy: config.updated_by,
      publishedVersion: publishedDefinition?.publishedVersion ?? null,
      publishedAt: publishedDefinition?.publishedAt ?? null,
    }
  })
}

export function upsertSyncDefinitionConfig(projectRoot: string, row: db.DbSyncDefinitionConfig): void {
  ensureSyncDefinitionConfigs(projectRoot, row.tenant_id)
  db.saveSyncDefinitionConfig(row)
}

export function resetSyncDefinitionConfig(projectRoot: string, tenantId: string, entityId: string): db.DbSyncDefinitionConfig | null {
  const entity = db.getEntityDefinition(tenantId, entityId)
  if (!entity) return null
  db.deleteSyncDefinitionConfig(tenantId, entityId)
  const reset = seedFromRepoDefinition(projectRoot, entity) ?? defaultConfigForEntity(entity)
  db.saveSyncDefinitionConfig(reset)
  return reset
}

export function publishSyncDefinitionsFromDb(projectRoot: string, tenantId = DEFAULT_TENANT_ID): {
  publishedAt: string
  publishedVersion: string
  definitionCount: number
  publishedBundlePath: string
  stdout: string[]
  stderr: string[]
} {
  ensureSyncDefinitionConfigs(projectRoot, tenantId)
  const entities = db.listEntityDefinitions(tenantId)
  const configs = new Map(db.listSyncDefinitionConfigs(tenantId).map((row) => [row.entity_id, row]))
  const publishedAt = new Date().toISOString()
  const publishedVersion = publishedAt
  const definitions: Record<string, PublishedSyncDefinition | null> = {}

  for (const entity of entities) {
    const config = configs.get(entity.id) ?? defaultConfigForEntity(entity)
    definitions[entity.id] = composeDefinition(entity, config, publishedAt, publishedVersion)
  }

  const bundle: PersistedPublishedBundle = {
    version: 1,
    publishedAt,
    publishedVersion,
    definitions,
  }
  const outputPath = resolve(projectRoot, PUBLISHED_BUNDLE_PATH)
  mkdirSync(resolve(projectRoot, "sync-definitions", "published"), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8")

  return {
    publishedAt,
    publishedVersion,
    definitionCount: Object.keys(definitions).length,
    publishedBundlePath: PUBLISHED_BUNDLE_PATH,
    stdout: [`Wrote published definition bundle to ${outputPath}`],
    stderr: [],
  }
}

export function listSeedableRepoDefinitionIds(projectRoot: string): string[] {
  const dir = resolve(projectRoot, AUTHORED_DEFINITIONS_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
}