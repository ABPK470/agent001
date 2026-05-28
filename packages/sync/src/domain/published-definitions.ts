import { existsSync, readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

import type { AgentHost } from "../ports/index.js"
import { PostMetadataActionKind, type PostMetadataActionKind as PostMetadataActionKindValue } from "./enums.js"
import { deriveArchiveTable, type SyncRecipe, type SyncRecipeDiscrepancy, type SyncRecipeTable } from "./recipes.js"

const DEFAULT_PUBLISHED_DEFINITIONS_PATH = "sync-definitions/published/definitions.bundle.json"

export interface PublishedSyncDefinitionGovernance {
  approvalPolicyId: string | null
  freezeWindowIds: string[]
  riskMultiplier: number
}

export interface PublishedSyncDefinitionBindings {
  serviceProfileRef: string
  environmentPolicyRef: string
}

export interface PublishedSyncDefinitionOwnership {
  team: string
  owner: string | null
  reviewStatus: "legacy-review-required" | "reviewed"
  notes: string[]
}

export interface PublishedSyncDefinitionStep {
  id: string
  phase: "pre-transaction" | "metadata" | "post-metadata" | "post-commit"
  kind: string
  title: string
  description: string
  bindingRef?: string | null
  policyRef?: string | null
  subjectRef?: "entityId" | "ruleInputDatasetId" | "contractPipelineId" | null
  objectName?: string | null
  auditObjectType?: string | null
  pipelineName?: string | null
}

export interface PublishedSyncDefinition {
  schemaVersion: 1
  id: string
  displayName: string
  description: string
  rootTable: string
  idColumn: string
  labelColumn: string | null
  selfJoinColumn: string | null
  legacy: {
    pipelineId: number | null
    entrySproc: string | null
  }
  governance: PublishedSyncDefinitionGovernance
  strategy: {
    strategyId: string
    strategyVersion: number | "latest"
  }
  bindings: PublishedSyncDefinitionBindings
  ownership: PublishedSyncDefinitionOwnership
  metadata: {
    tables: SyncRecipeTable[]
    executionOrder: string[]
    reverseOrder: string[]
    discrepancies: SyncRecipeDiscrepancy[]
  }
  executionFlow: {
    steps: PublishedSyncDefinitionStep[]
  }
  provenance: {
    kind: "manual" | "legacy-migration"
    sourceArtifact?: string | null
    sourceVersion?: string | null
  }
  publishedAt: string
  publishedVersion: string
}

export interface PublishedSyncDefinitionBundle {
  version: 1
  publishedAt: string
  publishedVersion: string
  definitions: Record<string, PublishedSyncDefinition | null>
}

export function loadPublishedSyncDefinitionBundle(
  host: AgentHost,
  projectRoot: string,
  relPath = DEFAULT_PUBLISHED_DEFINITIONS_PATH,
): PublishedSyncDefinitionBundle {
  const syncState = host.sync as typeof host.sync & {
    definitions?: {
      bundle: PublishedSyncDefinitionBundle | null
      loadedFromPath: string | null
      loadedFromMtimeMs: number | null
      loadedFromSize: number | null
    }
  }
  const full = resolve(projectRoot, relPath)
  if (!syncState.definitions) {
    syncState.definitions = { bundle: null, loadedFromPath: null, loadedFromMtimeMs: null, loadedFromSize: null }
  }
  if (!existsSync(full)) {
    throw new Error(
      `Published sync definition bundle not found at ${relPath}. ` +
      `Run npm run sync:definitions:compile -- --write before previewing syncs.`,
    )
  }
  const stats = statSync(full)
  if (
    syncState.definitions.bundle &&
    syncState.definitions.loadedFromPath === relPath &&
    syncState.definitions.loadedFromMtimeMs === stats.mtimeMs &&
    syncState.definitions.loadedFromSize === stats.size
  ) {
    return syncState.definitions.bundle
  }
  const parsed = JSON.parse(readFileSync(full, "utf-8")) as PublishedSyncDefinitionBundle
  if (parsed.version !== 1) {
    throw new Error(`Unsupported published sync definition bundle version: ${parsed.version}`)
  }
  syncState.definitions.bundle = parsed
  syncState.definitions.loadedFromPath = relPath
  syncState.definitions.loadedFromMtimeMs = stats.mtimeMs
  syncState.definitions.loadedFromSize = stats.size
  return parsed
}

export function getPublishedSyncDefinition(
  host: AgentHost,
  projectRoot: string,
  entityId: string,
): PublishedSyncDefinition {
  const bundle = loadPublishedSyncDefinitionBundle(host, projectRoot)
  const definition = bundle.definitions[entityId]
  if (!definition) {
    throw new Error(`No published sync definition exists for entity "${entityId}".`)
  }
  return definition
}

export function listPublishedSyncDefinitions(
  host: AgentHost,
  projectRoot: string,
): PublishedSyncDefinition[] {
  return Object.values(loadPublishedSyncDefinitionBundle(host, projectRoot).definitions)
    .filter((definition): definition is PublishedSyncDefinition => definition !== null)
}

export function getPublishedSyncDefinitionForHost(
  host: AgentHost,
  entityId: string,
): PublishedSyncDefinition {
  return getPublishedSyncDefinition(host, requireProjectRoot(host), entityId)
}

export function listPublishedSyncDefinitionsForHost(host: AgentHost): PublishedSyncDefinition[] {
  return listPublishedSyncDefinitions(host, requireProjectRoot(host))
}

export function getPublishedSyncRecipe(host: AgentHost, entityId: string): SyncRecipe {
  return definitionToSyncRecipe(getPublishedSyncDefinitionForHost(host, entityId))
}

export function definitionToSyncRecipe(definition: PublishedSyncDefinition): SyncRecipe {
  return {
    entityType: definition.id,
    displayName: definition.displayName,
    rootTable: definition.rootTable,
    rootKeyColumn: definition.idColumn,
    rootNameColumn: definition.labelColumn,
    legacyPipelineId: definition.legacy.pipelineId,
    selfJoinColumn: definition.selfJoinColumn,
    tables: definition.metadata.tables,
    executionOrder: definition.metadata.executionOrder,
    reverseOrder: definition.metadata.reverseOrder,
    postMetadataActions: definition.executionFlow.steps
      .filter((step) => step.phase === "post-metadata")
      .flatMap((step) => toPostMetadataAction(step.kind)),
    archiveTables: definition.metadata.tables.map((table) => deriveArchiveTable(table.name)),
    discrepancies: definition.metadata.discrepancies,
    generatedAt: definition.publishedAt,
  }
}

function toPostMetadataAction(kind: string): Array<{ kind: PostMetadataActionKindValue }> {
  switch (kind) {
    case "datasetDeploy":
      return [{ kind: PostMetadataActionKind.DatasetDeploy }]
    case "rulesDeploy":
      return [{ kind: PostMetadataActionKind.RulesDeploy }]
    case "pipelineRegister":
      return [{ kind: PostMetadataActionKind.PipelineRegister }]
    case "metaRefresh":
      return [{ kind: PostMetadataActionKind.MetaRefresh }]
    case "pipelineStart":
      return [{ kind: PostMetadataActionKind.PipelineStart }]
    case "handleDependencies":
      return [{ kind: PostMetadataActionKind.HandleDependencies }]
    case "syncDate":
      return [{ kind: PostMetadataActionKind.SyncDate }]
    case "deployDate":
      return [{ kind: PostMetadataActionKind.DeployDate }]
    default:
      return []
  }
}

function requireProjectRoot(host: AgentHost): string {
  const root = host.sync.dbProjectRoot
  if (!root) {
    throw new Error("Sync orchestrator not configured — call configureSyncOrchestrator(host, projectRoot)")
  }
  return root
}