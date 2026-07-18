import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import type {
  AuthoredSyncDefinition,
  AuthoredSyncFlowStep,
  EntityRegistrySyncFlowTemplateId,
  PublishedSyncDefinition,
  SyncDefinitionRuntimeOptions,
  SyncPublishStatus,
} from "@mia/shared-types"
import {
  buildSyncDefinitionFlowTemplateSteps,
  buildSyncDefinitionRuntimeFlowOptions,
  buildFlowCatalog,
  compilePublishedSyncDefinition,
  defaultSyncDefinitionFlowTemplateId,
  hasSyncDefinitionFlowTemplate,
  loadSyncDefinitionFlowTemplateCatalog,
  normalizeAuthoredSyncFlowSteps,
  resolveFlowSteps,
  validateAuthoredSyncFlow,
  validateEntityDefinition,
  type EntityDefinition,
  type SyncDefinitionFlowTemplate,
  type SyncDefinitionFlowTemplateCatalog
} from "@mia/sync"

import { reloadPublishedSyncVocabulary } from "../../../boot/published-sync-bundle.js"
import { _resetGoalClassificationCache } from "../../runs/prompting/goal-classification.js"
import * as db from "../../../infra/persistence/sqlite.js"

const DEFAULT_TENANT_ID = "_default"
const ENTITY_SEEDS_DIR = "deploy/sync/artifacts/entities"
const SYNC_DEFINITION_CONFIGS_SEED = "deploy/sync/artifacts/sync-definition-configs.json"
const SQLITE_PUBLISHED_STORAGE = "sqlite:sync_definitions" as const

const SERVICE_PROFILE_OPTIONS: SyncDefinitionRuntimeOptions["serviceProfiles"] = [
  {
    id: "default",
    label: "Default service routing",
    description: "Use the standard environment-resolved agent, ETL, and gate service endpoints."
  }
]

const ENVIRONMENT_POLICY_OPTIONS: SyncDefinitionRuntimeOptions["environmentPolicies"] = [
  {
    id: "default",
    label: "Default environment rules",
    description: "Apply the standard environment access mode, allowlist, and target checks."
  }
]

export interface SyncDefinitionAdminItem {
  id: string
  displayName: string
  entityVersion: number
  tableCount: number
  flowTemplateId: EntityRegistrySyncFlowTemplateId
  executionSteps: AuthoredSyncFlowStep[]
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
  needsPublish: boolean
}

export function defaultEntityFlowId(
  projectRoot: string,
  entityId: string,
  tenantId = DEFAULT_TENANT_ID,
): EntityRegistrySyncFlowTemplateId {
  return defaultFlowTemplateId(entityId, loadAuthoringFlowCatalog(projectRoot, tenantId))
}

export function listSyncDefinitionRuntimeOptions(projectRoot: string): SyncDefinitionRuntimeOptions {
  const presets = db.listSyncFlows("_default")
  if (presets.length > 0) {
    const flowTemplateSteps = Object.fromEntries(
      presets.map((preset) => [preset.id, db.parseFlowSteps(preset.steps_json)])
    ) as SyncDefinitionRuntimeOptions["flowTemplateSteps"]
    return {
      flowTemplates: presets.map((preset) => ({
        id: preset.id as EntityRegistrySyncFlowTemplateId,
        label: preset.label,
        description: preset.description
      })),
      flowTemplateSteps,
      serviceProfiles: SERVICE_PROFILE_OPTIONS,
      environmentPolicies: ENVIRONMENT_POLICY_OPTIONS
    }
  }

  const flowTemplateCatalog = loadFlowTemplateCatalog(projectRoot)
  return {
    flowTemplates: buildSyncDefinitionRuntimeFlowOptions(flowTemplateCatalog),
    flowTemplateSteps: buildSyncDefinitionFlowTemplateSteps(flowTemplateCatalog),
    serviceProfiles: SERVICE_PROFILE_OPTIONS,
    environmentPolicies: ENVIRONMENT_POLICY_OPTIONS
  }
}

interface PersistedPublishedBundle {
  version: 1
  publishedAt: string
  publishedVersion: string
  /** Active sync catalog version when this bundle was written. */
  catalogVersion?: number | null
  definitions: Record<string, PublishedSyncDefinition | null>
}

export function loadAuthoringFlowCatalog(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): SyncDefinitionFlowTemplateCatalog {
  const fileCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
  const presets = db.listSyncFlows(tenantId)
  if (presets.length === 0) return fileCatalog

  // DB presets override shipped flows; keep platform builtins (e.g. metadataOnly) from file catalog.
  const flowTemplates = { ...fileCatalog.flowTemplates } as Record<string, SyncDefinitionFlowTemplate>
  for (const preset of presets) {
    const dbSteps = db.parseFlowSteps(preset.steps_json)
    const fileSteps =
      preset.id in fileCatalog.flowTemplates
        ? fileCatalog.flowTemplates[preset.id as EntityRegistrySyncFlowTemplateId].steps
        : undefined
    flowTemplates[preset.id] = {
      label: preset.label,
      description: preset.description,
      steps: dbSteps.length > 0 ? dbSteps : (fileSteps ?? dbSteps),
    }
  }
  return {
    version: 1,
    flowTemplates: flowTemplates as SyncDefinitionFlowTemplateCatalog["flowTemplates"],
  }
}

/** @deprecated Use loadAuthoringFlowCatalog */
function loadFlowTemplateCatalog(projectRoot: string): SyncDefinitionFlowTemplateCatalog {
  return loadAuthoringFlowCatalog(projectRoot)
}

function defaultFlowTemplateId(
  entityId: string,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog
): EntityRegistrySyncFlowTemplateId {
  return defaultSyncDefinitionFlowTemplateId(entityId, flowTemplateCatalog)
}

function defaultConfigForEntity(
  entity: EntityDefinition,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog
): db.DbSyncDefinitionConfig {
  const now = new Date().toISOString()
  const flowTemplateId = defaultFlowTemplateId(entity.id, flowTemplateCatalog)
  return {
    tenant_id: entity.tenantId,
    entity_id: entity.id,
    flow_preset: flowTemplateId,
    execution_steps_json: JSON.stringify(resolveFlowSteps(flowTemplateId, flowTemplateCatalog)),
    service_profile_ref: "default",
    environment_policy_ref: "default",
    ownership_team: "sync-platform",
    ownership_owner: null,
    review_status: "legacy-review-required",
    ownership_notes_json: JSON.stringify([
      "Managed in DB via Entity Registry + Sync Admin.",
      "Review and publish after changing runtime bindings or flow preset."
    ]),
    updated_at: now,
    updated_by: null
  }
}

function inferFlowTemplateId(
  entityId: string,
  definition: Partial<AuthoredSyncDefinition>,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog
): EntityRegistrySyncFlowTemplateId {
  const kinds = (definition.executionFlow?.steps ?? []).map((step) => step.kind)
  for (const [templateId, steps] of Object.entries(
    buildSyncDefinitionFlowTemplateSteps(flowTemplateCatalog)
  ) as Array<[EntityRegistrySyncFlowTemplateId, AuthoredSyncDefinition["executionFlow"]["steps"]]>) {
    if (steps.map((step) => step.kind).join("|") === kinds.join("|")) return templateId
  }
  return defaultFlowTemplateId(entityId, flowTemplateCatalog)
}

/** Build sync_definition_configs row from an authored deploy artifact. */
export function syncConfigFromAuthoredSync(
  tenantId: string,
  entity: EntityDefinition,
  authored: AuthoredSyncDefinition,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog,
  actor: string,
  existing?: db.DbSyncDefinitionConfig | null,
): db.DbSyncDefinitionConfig {
  const base = existing ?? defaultConfigForEntity(entity, flowTemplateCatalog)
  const flowTemplateId = inferFlowTemplateId(entity.id, authored, flowTemplateCatalog)
  return {
    tenant_id: tenantId,
    entity_id: entity.id,
    flow_preset: flowTemplateId,
    execution_steps_json: JSON.stringify(resolveFlowSteps(flowTemplateId, flowTemplateCatalog)),
    service_profile_ref: authored.bindings?.serviceProfileRef ?? base.service_profile_ref,
    environment_policy_ref: authored.bindings?.environmentPolicyRef ?? base.environment_policy_ref,
    ownership_team: authored.ownership?.team ?? base.ownership_team,
    ownership_owner: authored.ownership?.owner ?? base.ownership_owner,
    review_status: authored.ownership?.reviewStatus ?? base.review_status,
    ownership_notes_json: JSON.stringify(
      authored.ownership?.notes ?? (JSON.parse(base.ownership_notes_json) as string[]),
    ),
    updated_at: new Date().toISOString(),
    updated_by: actor,
  }
}

type SeedConfigDoc = {
  configs?: Array<{
    entityId: string
    flowPreset: string
    serviceProfileRef: string
    environmentPolicyRef: string
    ownershipTeam: string
    ownershipOwner: string | null
    reviewStatus: "legacy-review-required" | "reviewed"
    ownershipNotes: string[]
  }>
}

function seedFromRepoDefinition(
  projectRoot: string,
  entity: EntityDefinition
): db.DbSyncDefinitionConfig | null {
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot)
  const configsPath = resolve(projectRoot, SYNC_DEFINITION_CONFIGS_SEED)
  if (existsSync(configsPath)) {
    try {
      const doc = JSON.parse(readFileSync(configsPath, "utf-8")) as SeedConfigDoc
      const row = (doc.configs ?? []).find((entry) => entry.entityId === entity.id)
      if (row) {
        const flowPreset =
          row.flowPreset?.trim() && hasSyncDefinitionFlowTemplate(flowTemplateCatalog, row.flowPreset)
            ? row.flowPreset
            : defaultFlowTemplateId(entity.id, flowTemplateCatalog)
        return {
          tenant_id: entity.tenantId,
          entity_id: entity.id,
          flow_preset: flowPreset,
          execution_steps_json: JSON.stringify(resolveFlowSteps(flowPreset, flowTemplateCatalog)),
          service_profile_ref: row.serviceProfileRef,
          environment_policy_ref: row.environmentPolicyRef,
          ownership_team: row.ownershipTeam,
          ownership_owner: row.ownershipOwner,
          review_status: row.reviewStatus,
          ownership_notes_json: JSON.stringify(row.ownershipNotes),
          updated_at: new Date().toISOString(),
          updated_by: "system",
        }
      }
    } catch (error) {
      console.warn(
        `[sync-definitions] failed to seed config from ${configsPath}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  // Compat: Authored entity seed still on disk (pre-unification trees).
  const authoredPath = resolve(projectRoot, ENTITY_SEEDS_DIR, `${entity.id}.json`)
  if (!existsSync(authoredPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(authoredPath, "utf-8")) as AuthoredSyncDefinition
    if (typeof parsed.schemaVersion !== "number" || !parsed.metadata?.tables) return null
    return syncConfigFromAuthoredSync(entity.tenantId, entity, parsed, flowTemplateCatalog, "system")
  } catch (error) {
    console.warn(
      `[sync-definitions] failed to seed config from ${authoredPath}:`,
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

function loadPublishedBundle(_projectRoot?: string): PersistedPublishedBundle | null {
  const raw = db.loadPublishedBundleFromDb(DEFAULT_TENANT_ID)
  if (!raw) return null
  return {
    version: 1,
    publishedAt: raw.publishedAt,
    publishedVersion: raw.publishedVersion,
    catalogVersion: raw.catalogVersion,
    definitions: raw.definitions as Record<string, PublishedSyncDefinition | null>,
  }
}

export function ensureSyncDefinitionConfigs(projectRoot: string, tenantId = DEFAULT_TENANT_ID): void {
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const entities = db.listEntityDefinitions(tenantId)
  if (entities.length === 0) return
  const existing = new Set(db.listSyncDefinitionConfigs(tenantId).map((row) => row.entity_id))
  for (const entity of entities) {
    if (existing.has(entity.id)) continue
    db.saveSyncDefinitionConfig(
      seedFromRepoDefinition(projectRoot, entity) ?? defaultConfigForEntity(entity, flowTemplateCatalog)
    )
  }
}

/** Re-resolve per-entity flow steps from catalog after bulk metadata/config import. */
export function rehydrateSyncDefinitionConfigSteps(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): void {
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  for (const row of db.listSyncDefinitionConfigs(tenantId)) {
    const flowPreset =
      row.flow_preset?.trim() && hasSyncDefinitionFlowTemplate(flowTemplateCatalog, row.flow_preset)
        ? row.flow_preset
        : defaultFlowTemplateId(row.entity_id, flowTemplateCatalog)
    db.saveSyncDefinitionConfig({
      ...row,
      flow_preset: flowPreset,
      execution_steps_json: JSON.stringify(resolveFlowSteps(flowPreset, flowTemplateCatalog)),
    })
  }
}

function resolveCatalogPublishGap(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): {
  catalogNeedsPublish: boolean
  activeCatalogVersion: number | null
  publishedCatalogVersion: number | null
  publishedAt: string | null
  published: PersistedPublishedBundle | null
} {
  const published = loadPublishedBundle(projectRoot)
  const activeCatalogVersion = db.getActiveSyncCatalogVersion(tenantId)
  const publishedCatalogVersion = published?.catalogVersion ?? null
  const publishedAt = published?.publishedAt ?? null
  const catalogNeedsPublish =
    published == null ||
    publishedCatalogVersion == null ||
    (activeCatalogVersion != null && activeCatalogVersion !== publishedCatalogVersion)
  return {
    catalogNeedsPublish,
    activeCatalogVersion,
    publishedCatalogVersion,
    publishedAt,
    published,
  }
}

export function getSyncPublishStatus(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): SyncPublishStatus {
  const gap = resolveCatalogPublishGap(projectRoot, tenantId)
  // Catalog tip is enough to arm Publish; entity ids are best-effort detail.
  let unpublishedEntityIds: string[] = []
  try {
    unpublishedEntityIds = listSyncDefinitionAdminItems(projectRoot, tenantId)
      .filter((item) => item.needsPublish)
      .map((item) => item.id)
  } catch {
    unpublishedEntityIds = []
  }
  return {
    catalogNeedsPublish: gap.catalogNeedsPublish,
    activeCatalogVersion: gap.activeCatalogVersion,
    publishedCatalogVersion: gap.publishedCatalogVersion,
    publishedAt: gap.publishedAt,
    unpublishedEntityCount: unpublishedEntityIds.length,
    unpublishedEntityIds,
  }
}

export function listSyncDefinitionAdminItems(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID
): SyncDefinitionAdminItem[] {
  ensureSyncDefinitionConfigs(projectRoot, tenantId)
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const entities = db.listEntityDefinitions(tenantId)
  const configs = new Map(db.listSyncDefinitionConfigs(tenantId).map((row) => [row.entity_id, row]))
  const gap = resolveCatalogPublishGap(projectRoot, tenantId)
  const published = gap.published
  return entities.map((entity) => {
    const config = configs.get(entity.id) ?? defaultConfigForEntity(entity, flowTemplateCatalog)
    const flowTemplateId = config.flow_preset as EntityRegistrySyncFlowTemplateId
    const publishedDefinition = published?.definitions?.[entity.id] ?? null
    const publishedAt = publishedDefinition?.publishedAt ?? null
    const publishedSourceVersion = publishedDefinition?.provenance?.sourceVersion ?? null
    const entityNeedsPublish =
      publishedDefinition == null ||
      publishedSourceVersion !== String(entity.version) ||
      (publishedAt != null && config.updated_at > publishedAt)
    // Catalog tip ahead of last publish (metadata/wiring/envs/…) means every
    // definition would be recompiled — surface that on each admin row.
    const needsPublish = entityNeedsPublish || gap.catalogNeedsPublish
    return {
      id: entity.id,
      displayName: entity.displayName,
      entityVersion: entity.version,
      tableCount: entity.tables.length,
      flowTemplateId,
      executionSteps: resolveFlowSteps(flowTemplateId, flowTemplateCatalog),
      serviceProfileRef: config.service_profile_ref,
      environmentPolicyRef: config.environment_policy_ref,
      ownershipTeam: config.ownership_team,
      ownershipOwner: config.ownership_owner,
      reviewStatus: config.review_status,
      ownershipNotes: JSON.parse(config.ownership_notes_json) as string[],
      updatedAt: config.updated_at,
      updatedBy: config.updated_by,
      publishedVersion: publishedDefinition?.publishedVersion ?? null,
      publishedAt,
      needsPublish,
    }
  })
}

export function upsertSyncDefinitionConfig(projectRoot: string, row: db.DbSyncDefinitionConfig): void {
  ensureSyncDefinitionConfigs(projectRoot, row.tenant_id)
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, row.tenant_id)
  const flowPreset =
    row.flow_preset || defaultFlowTemplateId(row.entity_id, flowTemplateCatalog)
  db.saveSyncDefinitionConfig({
    ...row,
    flow_preset: flowPreset,
    execution_steps_json: JSON.stringify(resolveFlowSteps(flowPreset, flowTemplateCatalog)),
  })
}

export function resetSyncDefinitionConfig(
  projectRoot: string,
  tenantId: string,
  entityId: string
): db.DbSyncDefinitionConfig | null {
  const entity = db.getEntityDefinition(tenantId, entityId)
  if (!entity) return null
  db.deleteSyncDefinitionConfig(tenantId, entityId)
  const reset =
    seedFromRepoDefinition(projectRoot, entity) ??
    defaultConfigForEntity(entity, loadAuthoringFlowCatalog(projectRoot, tenantId))
  db.saveSyncDefinitionConfig(reset)
  return reset
}

function resolveExecutionStepsForValidation(
  config: { flow_preset: string },
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog,
): AuthoredSyncFlowStep[] {
  return resolveFlowSteps(config.flow_preset, flowTemplateCatalog)
}

export class PublishSyncDefinitionsError extends Error {
  readonly stderr: string[]

  constructor(stderr: string[]) {
    super(
      stderr.length > 0
        ? `Publish refused all entities: ${stderr.join(" ")}`
        : "Publish refused all entities",
    )
    this.name = "PublishSyncDefinitionsError"
    this.stderr = stderr
  }
}

export function publishSyncDefinitionsFromDb(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID
): {
  publishedAt: string
  publishedVersion: string
  definitionCount: number
  publishedStorage: "sqlite"
  publishedBundlePath: string
  stdout: string[]
  stderr: string[]
} {
  ensureSyncDefinitionConfigs(projectRoot, tenantId)
  rehydrateSyncDefinitionConfigSteps(projectRoot, tenantId)
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const flowCatalog = buildFlowCatalog(
    db.listSyncPhases(tenantId),
    db.listSyncActions(tenantId),
    db.listSyncValueSources(tenantId),
  )
  const entities = db.listEntityDefinitions(tenantId)
  const configs = new Map(db.listSyncDefinitionConfigs(tenantId).map((row) => [row.entity_id, row]))
  const publishedAt = new Date().toISOString()
  const publishedVersion = publishedAt
  const compiled: Record<string, PublishedSyncDefinition | null> = {}
  const stderr: string[] = []

  for (const entity of entities) {
    const entityValidation = validateEntityDefinition(entity)
    if (!entityValidation.ok) {
      stderr.push(
        `Refusing to publish "${entity.id}": ${entityValidation.errors.map((issue) => issue.message).join("; ")}`
      )
      compiled[entity.id] = null
      continue
    }
    for (const warning of entityValidation.warnings) {
      stderr.push(`[${entity.id}] ${warning.message}`)
    }
    const config = configs.get(entity.id) ?? defaultConfigForEntity(entity, flowTemplateCatalog)
    const steps = normalizeAuthoredSyncFlowSteps(
      resolveExecutionStepsForValidation(config, flowTemplateCatalog),
      { entityId: entity.id, rootTable: entity.rootTable },
      flowCatalog,
    )
    const validation = validateAuthoredSyncFlow(steps, entity.id, flowCatalog)
    if (validation.errors.length > 0) {
      stderr.push(
        `Refusing to publish "${entity.id}": ${validation.errors.map((issue) => issue.message).join("; ")}`
      )
      compiled[entity.id] = null
      continue
    }
    for (const warning of validation.warnings) {
      stderr.push(`[${entity.id}] ${warning.message}`)
    }
    compiled[entity.id] = compilePublishedSyncDefinition(
      entity,
      config,
      flowTemplateCatalog,
      flowCatalog,
      publishedAt,
      publishedVersion,
      (strategyId, strategyVersion) =>
        db.resolveScd2Strategy(
          tenantId,
          strategyId,
          strategyVersion === "latest" ? "latest" : strategyVersion,
        ),
    )
  }

  const newlyPublishedCount = Object.values(compiled).filter((value) => value !== null).length
  if (newlyPublishedCount === 0) {
    throw new PublishSyncDefinitionsError(stderr)
  }

  const previousBundle = loadPublishedBundle(projectRoot)
  const definitions: Record<string, PublishedSyncDefinition | null> = {}
  for (const entity of entities) {
    definitions[entity.id] =
      compiled[entity.id] ?? previousBundle?.definitions?.[entity.id] ?? null
  }

  const catalogVersion = db.getActiveSyncCatalogVersion(tenantId)
  db.replaceSyncDefinitions(tenantId, {
    publishedAt,
    publishedVersion,
    catalogVersion,
    definitions,
  })

  const vocabularyIds = reloadPublishedSyncVocabulary(projectRoot)
  _resetGoalClassificationCache()

  const definitionCount = Object.values(definitions).filter((value) => value !== null).length

  return {
    publishedAt,
    publishedVersion,
    definitionCount,
    publishedStorage: "sqlite" as const,
    publishedBundlePath: SQLITE_PUBLISHED_STORAGE,
    stdout: [
      `Published SyncDefinitions to SQLite (${SQLITE_PUBLISHED_STORAGE})`,
      `Published ${newlyPublishedCount} definition(s) this run; ${definitionCount} live total`,
      `Reloaded published sync vocabulary (${vocabularyIds.length} entity types)`,
    ],
    stderr
  }
}
