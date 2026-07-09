import type { PublishedSyncDefinition, PublishedSyncDefinitionBundle } from "@mia/shared-types"

import type { SyncProjectRootHost } from "../ports/index.js"

const DEFAULT_PUBLISHED_DEFINITIONS_PATH = "sync-definitions/published/definitions.bundle.json"

export type { PublishedSyncDefinition, PublishedSyncDefinitionBundle }

export function loadPublishedSyncDefinitionBundle(
  host: SyncProjectRootHost,
  projectRoot: string,
  relPath = DEFAULT_PUBLISHED_DEFINITIONS_PATH
): PublishedSyncDefinitionBundle {
  return host.sync.project.publishedDefinitions.loadBundle(projectRoot, relPath)
}

export function getPublishedSyncDefinition(
  host: SyncProjectRootHost,
  projectRoot: string,
  entityId: string
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
  projectRoot: string
): PublishedSyncDefinition[] {
  return Object.values(loadPublishedSyncDefinitionBundle(host, projectRoot).definitions).filter(
    (definition): definition is PublishedSyncDefinition => definition !== null
  )
}

export function getPublishedSyncDefinitionForHost(
  host: SyncProjectRootHost,
  entityId: string
): PublishedSyncDefinition {
  return getPublishedSyncDefinition(host, requireProjectRoot(host), entityId)
}

export function listPublishedSyncDefinitionsForHost(host: SyncProjectRootHost): PublishedSyncDefinition[] {
  return listPublishedSyncDefinitions(host, requireProjectRoot(host))
}

export function listPublishedSyncDefinitionIds(host: SyncProjectRootHost): string[] {
  const bundle = loadPublishedSyncDefinitionBundle(host, requireProjectRoot(host))
  return Object.entries(bundle.definitions)
    .filter(([, definition]) => definition !== null)
    .map(([id]) => id)
}

export function isPublishedSyncEntityType(host: SyncProjectRootHost, entityType: string): boolean {
  const bundle = loadPublishedSyncDefinitionBundle(host, requireProjectRoot(host))
  return entityType in bundle.definitions && bundle.definitions[entityType] !== null
}

function requireProjectRoot(host: SyncProjectRootHost): string {
  const root = host.sync.project.dbProjectRoot
  if (!root) {
    throw new Error("Sync orchestrator not configured — call configureSyncOrchestrator(host, projectRoot)")
  }
  return root
}
