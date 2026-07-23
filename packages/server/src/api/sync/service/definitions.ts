import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseBoundaryJson } from "../../../internal/parse-json.js"

import type {
  AuthoredSyncFlowStep,
  EntityRegistrySyncFlowTemplateId,
  PublishedSyncDefinition,
  SyncDefinitionRuntimeOptions,
  SyncPublishPreview,
  SyncPublishStatus,
} from "@mia/shared-types"
import {
  asEntityId,
  asFlowId,
  buildSyncDefinitionFlowTemplateSteps,
  buildSyncDefinitionRuntimeFlowOptions,
  buildFlowCatalog,
  compilePublishedSyncDefinition,
  syncDefinitionConfigFromEntity,
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
import {
  COMPILE_CATALOG_SECTIONS,
  classifyCatalogPublish,
} from "./catalog-publish-classification.js"

const DEFAULT_TENANT_ID = "_default"
const ENTITY_SEEDS_DIR = "deploy/sync/artifacts/entities"
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
  return defaultSyncDefinitionFlowTemplateId(asEntityId(entityId), flowTemplateCatalog)
}

/** Prefer shipped seed flowId (legacy run.template accepted). */
export function seedFlowIdFromRepo(projectRoot: string, entityId: string): string | null {
  const entityPath = resolve(projectRoot, ENTITY_SEEDS_DIR, `${entityId}.json`)
  if (!existsSync(entityPath)) return null
  try {
    const raw = parseBoundaryJson(readFileSync(entityPath, "utf-8")) as {
      flowId?: string
      run?: { template?: string }
    }
    return raw.flowId?.trim() || raw.run?.template?.trim() || null
  } catch (error) {
    console.warn(
      `[sync-definitions] failed to read seed flowId from ${entityPath}:`,
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

export function getSyncPublishStatus(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): SyncPublishStatus {
  const classified = classifyCatalogPublish(projectRoot, tenantId)
  const unpublishedEntityIds = [...classified.compileAffectedEntityIds].sort()
  return {
    // Arms Publish only for compile-relevant tip deltas (not env-only).
    catalogNeedsPublish: classified.compileNeedsPublish,
    operationalCatalogAhead: classified.operationalOnlyAhead,
    dirtyCompileSections: classified.dirtyCompileSections,
    dirtyOperationalSections: classified.dirtyOperationalSections,
    activeCatalogVersion: classified.activeCatalogVersion,
    publishedCatalogVersion: classified.publishedCatalogVersion,
    publishedAt: classified.publishedAt,
    unpublishedEntityCount: unpublishedEntityIds.length,
    unpublishedEntityIds,
  }
}

/** Live tip vs published catalog snapshot — Publish modal SoT (not version-history JSON). */
export function getSyncPublishPreview(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID,
): SyncPublishPreview {
  const classified = classifyCatalogPublish(projectRoot, tenantId)
  const sections = (classified.diff?.sections ?? [])
    .filter((s) => COMPILE_CATALOG_SECTIONS.has(s.section))
    .map((s) => ({
      section: s.section,
      label: s.label,
      creates: s.creates.map((e) => ({
        id: e.id,
        kind: "create" as const,
        changedPaths: e.changedPaths,
        beforeJson: e.beforeJson,
        afterJson: e.afterJson,
      })),
      updates: s.updates.map((e) => ({
        id: e.id,
        kind: "update" as const,
        changedPaths: e.changedPaths,
        beforeJson: e.beforeJson,
        afterJson: e.afterJson,
      })),
      deletes: s.deletes.map((e) => ({
        id: e.id,
        kind: "delete" as const,
        changedPaths: e.changedPaths,
        beforeJson: e.beforeJson,
        afterJson: e.afterJson,
      })),
    }))
  const changeCount = sections.reduce(
    (n, s) => n + s.creates.length + s.updates.length + s.deletes.length,
    0,
  )
  return {
    activeCatalogVersion: classified.activeCatalogVersion,
    publishedCatalogVersion: classified.publishedCatalogVersion,
    catalogNeedsPublish: classified.compileNeedsPublish,
    operationalCatalogAhead: classified.operationalOnlyAhead,
    changeCount,
    sections,
  }
}

/** True when this entity's published SyncDefinition is behind compile-relevant tip. */
export function entityNeedsRepublish(
  projectRoot: string,
  entityId: string,
  tenantId = DEFAULT_TENANT_ID,
): boolean {
  const classified = classifyCatalogPublish(projectRoot, tenantId)
  return classified.compileAffectedEntityIds.includes(entityId)
}

/**
 * Admin list for Publish UI. Flow comes from entity.flowId + catalog.
 * Bindings/ownership fields are compose-time stubs (same as Publish), not tip SoT.
 */
export function listSyncDefinitionAdminItems(
  projectRoot: string,
  tenantId = DEFAULT_TENANT_ID
): SyncDefinitionAdminItem[] {
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const entities = db.listEntityDefinitions(tenantId)
  const classified = classifyCatalogPublish(projectRoot, tenantId)
  const published = classified.published
  const compileAffected = new Set(classified.compileAffectedEntityIds)
  return entities.map((entity) => {
    const compose = syncDefinitionConfigFromEntity(entity, flowTemplateCatalog)
    const flowTemplateId = compose.flow_preset as EntityRegistrySyncFlowTemplateId
    const publishedDefinition = published?.definitions?.[entity.id] ?? null
    const publishedAt = publishedDefinition?.publishedAt ?? null
    const needsPublish = compileAffected.has(entity.id)
    return {
      id: entity.id,
      displayName: entity.displayName,
      entityVersion: entity.version,
      tableCount: entity.tables.length,
      flowTemplateId,
      executionSteps: resolveFlowSteps(flowTemplateId, flowTemplateCatalog),
      serviceProfileRef: compose.service_profile_ref,
      environmentPolicyRef: compose.environment_policy_ref,
      ownershipTeam: compose.ownership_team,
      ownershipOwner: compose.ownership_owner,
      reviewStatus: compose.review_status,
      ownershipNotes: parseBoundaryJson(compose.ownership_notes_json) as string[],
      updatedAt: entity.createdAt,
      updatedBy: entity.createdBy,
      publishedVersion: publishedDefinition?.publishedVersion ?? null,
      publishedAt,
      needsPublish,
    }
  })
}

/** Reset entity.flowId to shipped seed (or catalog default). */
export function resetEntityFlowId(
  projectRoot: string,
  tenantId: string,
  entityId: string,
  actor: string,
): EntityDefinition | null {
  const entity = db.getEntityDefinition(tenantId, entityId)
  if (!entity) return null
  const catalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const seedFlow = seedFlowIdFromRepo(projectRoot, entityId)
  const flowId =
    seedFlow && hasSyncDefinitionFlowTemplate(catalog, seedFlow)
      ? seedFlow
      : defaultFlowTemplateId(entityId, catalog)
  const result = db.saveEntityDefinition({
    tenantId,
    def: { ...entity, flowId: asFlowId(flowId) },
    actor,
    reason: "sync-definition-config:reset",
  })
  return db.getEntityDefinition(tenantId, result.id) ?? null
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
  const flowTemplateCatalog = loadAuthoringFlowCatalog(projectRoot, tenantId)
  const flowCatalog = buildFlowCatalog(
    db.listSyncPhases(tenantId),
    db.listSyncActions(tenantId),
    db.listSyncValueSources(tenantId),
  )
  const entities = db.listEntityDefinitions(tenantId)
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
    // Tip SoT: entity.flowId. Compose stubs (bindings/ownership) are not tip fields.
    const config = syncDefinitionConfigFromEntity(entity, flowTemplateCatalog)
    const steps = normalizeAuthoredSyncFlowSteps(
      resolveExecutionStepsForValidation(config, flowTemplateCatalog),
      { entityId: entity.id, rootTable: entity.rootTable },
      flowCatalog,
    )
    const validation = validateAuthoredSyncFlow(steps, asEntityId(entity.id), flowCatalog)
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
