import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type {
  AuthoredSyncDefinition,
  AuthoredSyncFlowStep,
  EntityRegistrySyncFlowTemplateId,
  PublishedSyncDefinition,
  SyncDefinitionRuntimeOptions
} from "@mia/shared-types"
import {
  buildSyncDefinitionFlowTemplateSteps,
  buildSyncDefinitionRuntimeFlowOptions,
  buildFlowCatalog,
  compilePublishedSyncDefinition,
  defaultSyncDefinitionFlowTemplateId,
  loadSyncDefinitionFlowTemplateCatalog,
  normalizeAuthoredSyncFlowSteps,
  resolveFlowSteps,
  validateAuthoredSyncFlow,
  validateEntityDefinition,
  type EntityDefinition,
  type SyncDefinitionFlowTemplateCatalog
} from "@mia/sync"

import {
  PUBLISHED_SYNC_BUNDLE_PATH,
  reloadPublishedSyncVocabulary
} from "../../../bootstrap/published-sync-bundle.js"
import { _resetGoalClassificationCache } from "../../runs/core/goal-classification.js"
import * as db from "../../../platform/persistence/sqlite.js"

const DEFAULT_TENANT_ID = "_default"
const PUBLISHED_BUNDLE_PATH = PUBLISHED_SYNC_BUNDLE_PATH
const AUTHORED_DEFINITIONS_DIR = "deploy/sync/artifacts/entities"

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
}

export function defaultEntityFlowId(
  projectRoot: string,
  entityId: string,
  tenantId = DEFAULT_TENANT_ID,
): EntityRegistrySyncFlowTemplateId {
  return defaultFlowTemplateId(entityId, loadAuthoringFlowCatalog(projectRoot, tenantId))
}

export function listSyncDefinitionRuntimeOptions(projectRoot: string): SyncDefinitionRuntimeOptions {
  const presets = db.listSyncRunPresets("_default")
  if (presets.length > 0) {
    const flowTemplateSteps = Object.fromEntries(
      presets.map((preset) => [preset.id, db.parsePresetSteps(preset.steps_json)])
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
  definitions: Record<string, PublishedSyncDefinition | null>
}

function loadAuthoringFlowCatalog(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): SyncDefinitionFlowTemplateCatalog {
  const presets = db.listSyncRunPresets(tenantId)
  if (presets.length > 0) {
    const flowTemplates = Object.fromEntries(
      presets.map((preset) => [
        preset.id,
        {
          label: preset.label,
          description: preset.description,
          steps: db.parsePresetSteps(preset.steps_json),
        },
      ]),
    )
    return {
      version: 1,
      flowTemplates: flowTemplates as SyncDefinitionFlowTemplateCatalog["flowTemplates"],
    }
  }
  return loadSyncDefinitionFlowTemplateCatalog(projectRoot)
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

function seedFromRepoDefinition(
  projectRoot: string,
  entity: EntityDefinition
): db.DbSyncDefinitionConfig | null {
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot)
  const path = resolve(projectRoot, AUTHORED_DEFINITIONS_DIR, `${entity.id}.json`)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AuthoredSyncDefinition>
    const base = defaultConfigForEntity(entity, flowTemplateCatalog)
    const flowTemplateId = inferFlowTemplateId(entity.id, parsed, flowTemplateCatalog)
    return {
      ...base,
      flow_preset: flowTemplateId,
      execution_steps_json: JSON.stringify(resolveFlowSteps(flowTemplateId, flowTemplateCatalog)),
      service_profile_ref: parsed.bindings?.serviceProfileRef ?? base.service_profile_ref,
      environment_policy_ref: parsed.bindings?.environmentPolicyRef ?? base.environment_policy_ref,
      ownership_team: parsed.ownership?.team ?? base.ownership_team,
      ownership_owner: parsed.ownership?.owner ?? base.ownership_owner,
      review_status: parsed.ownership?.reviewStatus ?? base.review_status,
      ownership_notes_json: JSON.stringify(
        parsed.ownership?.notes ?? (JSON.parse(base.ownership_notes_json) as string[])
      )
    }
  } catch (error) {
    console.warn(
      `[sync-definitions] failed to seed config from ${path}:`,
      error instanceof Error ? error.message : error
    )
    return null
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

export function listSyncDefinitionAdminItems(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID
): SyncDefinitionAdminItem[] {
  ensureSyncDefinitionConfigs(projectRoot, tenantId)
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const entities = db.listEntityDefinitions(tenantId)
  const configs = new Map(db.listSyncDefinitionConfigs(tenantId).map((row) => [row.entity_id, row]))
  const published = loadPublishedBundle(projectRoot)
  return entities.map((entity) => {
    const config = configs.get(entity.id) ?? defaultConfigForEntity(entity, flowTemplateCatalog)
    const flowTemplateId = config.flow_preset as EntityRegistrySyncFlowTemplateId
    const publishedDefinition = published?.definitions?.[entity.id] ?? null
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
      publishedAt: publishedDefinition?.publishedAt ?? null
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

export function publishSyncDefinitionsFromDb(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID
): {
  publishedAt: string
  publishedVersion: string
  definitionCount: number
  publishedBundlePath: string
  stdout: string[]
  stderr: string[]
} {
  ensureSyncDefinitionConfigs(projectRoot, tenantId)
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const flowCatalog = buildFlowCatalog(
    db.listSyncRunPhases(tenantId),
    db.listSyncRunKinds(tenantId),
    db.listSyncRunBindingSources(tenantId),
  )
  const entities = db.listEntityDefinitions(tenantId)
  const configs = new Map(db.listSyncDefinitionConfigs(tenantId).map((row) => [row.entity_id, row]))
  const publishedAt = new Date().toISOString()
  const publishedVersion = publishedAt
  const definitions: Record<string, PublishedSyncDefinition | null> = {}
  const stderr: string[] = []

  for (const entity of entities) {
    const entityValidation = validateEntityDefinition(entity)
    if (!entityValidation.ok) {
      stderr.push(
        `Refusing to publish "${entity.id}": ${entityValidation.errors.map((issue) => issue.message).join("; ")}`
      )
      definitions[entity.id] = null
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
      definitions[entity.id] = null
      continue
    }
    for (const warning of validation.warnings) {
      stderr.push(`[${entity.id}] ${warning.message}`)
    }
    definitions[entity.id] = compilePublishedSyncDefinition(
      entity,
      config,
      flowTemplateCatalog,
      flowCatalog,
      publishedAt,
      publishedVersion,
    )
  }

  const bundle: PersistedPublishedBundle = {
    version: 1,
    publishedAt,
    publishedVersion,
    definitions
  }
  const outputPath = resolve(projectRoot, PUBLISHED_BUNDLE_PATH)
  mkdirSync(resolve(projectRoot, "sync-definitions", "published"), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf-8")

  const vocabularyIds = reloadPublishedSyncVocabulary(projectRoot)
  _resetGoalClassificationCache()

  return {
    publishedAt,
    publishedVersion,
    definitionCount: Object.keys(definitions).length,
    publishedBundlePath: PUBLISHED_BUNDLE_PATH,
    stdout: [
      `Wrote published definition bundle to ${outputPath}`,
      `Reloaded published sync vocabulary (${vocabularyIds.length} entity types)`
    ],
    stderr
  }
}
