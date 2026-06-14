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
  composePublishedSyncDefinition,
  defaultSyncDefinitionFlowTemplateId,
  getSyncDefinitionFlowTemplateSteps,
  loadSyncDefinitionFlowTemplateCatalog,
  type EntityDefinition,
  type SyncDefinitionFlowTemplateCatalog
} from "@mia/sync"

import * as db from "../../../platform/persistence/sqlite.js"

const DEFAULT_TENANT_ID = "_default"
const PUBLISHED_BUNDLE_PATH = "sync-definitions/published/definitions.bundle.json"
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

export function listSyncDefinitionRuntimeOptions(projectRoot: string): SyncDefinitionRuntimeOptions {
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

function loadFlowTemplateCatalog(projectRoot: string): SyncDefinitionFlowTemplateCatalog {
  return loadSyncDefinitionFlowTemplateCatalog(projectRoot)
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
    execution_steps_json: JSON.stringify(
      getSyncDefinitionFlowTemplateSteps(flowTemplateCatalog, flowTemplateId)
    ),
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

function resolveExecutionSteps(
  config: Pick<db.DbSyncDefinitionConfig, "execution_steps_json" | "flow_preset">,
  entityId: string,
  flowTemplateCatalog: SyncDefinitionFlowTemplateCatalog
): AuthoredSyncFlowStep[] {
  try {
    const parsed = JSON.parse(config.execution_steps_json) as unknown
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as AuthoredSyncFlowStep[]
  } catch {
    // fall through to preset-derived default
  }
  const flowTemplateId = (
    config.flow_preset in flowTemplateCatalog.flowTemplates
      ? config.flow_preset
      : defaultFlowTemplateId(entityId, flowTemplateCatalog)
  ) as EntityRegistrySyncFlowTemplateId
  return getSyncDefinitionFlowTemplateSteps(flowTemplateCatalog, flowTemplateId)
}

function seedFromRepoDefinition(
  projectRoot: string,
  entity: EntityDefinition
): db.DbSyncDefinitionConfig | null {
  const flowTemplateCatalog = loadFlowTemplateCatalog(projectRoot)
  const path = resolve(projectRoot, AUTHORED_DEFINITIONS_DIR, `${entity.id}.json`)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AuthoredSyncDefinition>
    const base = defaultConfigForEntity(entity, flowTemplateCatalog)
    return {
      ...base,
      flow_preset: inferFlowTemplateId(entity.id, parsed, flowTemplateCatalog),
      execution_steps_json: JSON.stringify(
        parsed.executionFlow?.steps ?? resolveExecutionSteps(base, entity.id, flowTemplateCatalog)
      ),
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
  const flowTemplateCatalog = loadFlowTemplateCatalog(projectRoot)
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
  const flowTemplateCatalog = loadFlowTemplateCatalog(projectRoot)
  const entities = db.listEntityDefinitions(tenantId)
  const configs = new Map(db.listSyncDefinitionConfigs(tenantId).map((row) => [row.entity_id, row]))
  const published = loadPublishedBundle(projectRoot)
  return entities.map((entity) => {
    const config = configs.get(entity.id) ?? defaultConfigForEntity(entity, flowTemplateCatalog)
    const publishedDefinition = published?.definitions?.[entity.id] ?? null
    return {
      id: entity.id,
      displayName: entity.displayName,
      entityVersion: entity.version,
      tableCount: entity.tables.length,
      flowTemplateId: (config.flow_preset in flowTemplateCatalog.flowTemplates
        ? config.flow_preset
        : defaultFlowTemplateId(entity.id, flowTemplateCatalog)) as EntityRegistrySyncFlowTemplateId,
      executionSteps: resolveExecutionSteps(config, entity.id, flowTemplateCatalog),
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
  const flowTemplateCatalog = loadFlowTemplateCatalog(projectRoot)
  db.saveSyncDefinitionConfig({
    ...row,
    flow_preset: row.flow_preset || defaultFlowTemplateId(row.entity_id, flowTemplateCatalog)
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
    defaultConfigForEntity(entity, loadFlowTemplateCatalog(projectRoot))
  db.saveSyncDefinitionConfig(reset)
  return reset
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
  const flowTemplateCatalog = loadFlowTemplateCatalog(projectRoot)
  const entities = db.listEntityDefinitions(tenantId)
  const configs = new Map(db.listSyncDefinitionConfigs(tenantId).map((row) => [row.entity_id, row]))
  const publishedAt = new Date().toISOString()
  const publishedVersion = publishedAt
  const definitions: Record<string, PublishedSyncDefinition | null> = {}

  for (const entity of entities) {
    const config = configs.get(entity.id) ?? defaultConfigForEntity(entity, flowTemplateCatalog)
    definitions[entity.id] = composePublishedSyncDefinition(
      entity,
      config,
      flowTemplateCatalog,
      publishedAt,
      publishedVersion
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

  return {
    publishedAt,
    publishedVersion,
    definitionCount: Object.keys(definitions).length,
    publishedBundlePath: PUBLISHED_BUNDLE_PATH,
    stdout: [`Wrote published definition bundle to ${outputPath}`],
    stderr: []
  }
}
