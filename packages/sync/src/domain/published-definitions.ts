import type { SyncProjectRootHost } from "../ports/index.js"
import { PostMetadataActionKind, type PostMetadataActionKind as PostMetadataActionKindValue } from "./enums.js"
import { deriveArchiveTable, type SyncRecipe, type SyncRecipeDiscrepancy, type SyncRecipeTable } from "./recipes.js"

const DEFAULT_PUBLISHED_DEFINITIONS_PATH = "sync-definitions/published/definitions.bundle.json"

export interface PublishedSyncDefinitionGovernance {
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
  host: SyncProjectRootHost,
  projectRoot: string,
  relPath = DEFAULT_PUBLISHED_DEFINITIONS_PATH,
): PublishedSyncDefinitionBundle {
  return host.sync.publishedDefinitions.loadBundle(projectRoot, relPath)
}

export function getPublishedSyncDefinition(
  host: SyncProjectRootHost,
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
  host: SyncProjectRootHost,
  projectRoot: string,
): PublishedSyncDefinition[] {
  return Object.values(loadPublishedSyncDefinitionBundle(host, projectRoot).definitions)
    .filter((definition): definition is PublishedSyncDefinition => definition !== null)
}

export function getPublishedSyncDefinitionForHost(
  host: SyncProjectRootHost,
  entityId: string,
): PublishedSyncDefinition {
  return getPublishedSyncDefinition(host, requireProjectRoot(host), entityId)
}

export function listPublishedSyncDefinitionsForHost(host: SyncProjectRootHost): PublishedSyncDefinition[] {
  return listPublishedSyncDefinitions(host, requireProjectRoot(host))
}

export function getPublishedSyncRecipe(host: SyncProjectRootHost, entityId: string): SyncRecipe {
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

function requireProjectRoot(host: SyncProjectRootHost): string {
  const root = host.sync.dbProjectRoot
  if (!root) {
    throw new Error("Sync orchestrator not configured — call configureSyncOrchestrator(host, projectRoot)")
  }
  return root
}