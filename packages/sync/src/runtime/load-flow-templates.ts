/**
 * Disk loaders for sync definition flow template catalogs.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  DEFAULT_SYNC_DEFINITION_FLOW_TEMPLATES_PATH,
  parseFlowTemplateCatalog,
  type SyncDefinitionFlowTemplateCatalog,
} from "../domain/sync-definition-flow-templates.js"
import {
  DEFAULT_SYNC_METADATA_PATH,
  loadSyncMetadataArtifact,
  syncMetadataFlowTemplateCatalog,
} from "./artifacts/load-sync-metadata-artifact.js"

/** Raw shape parsed from disk/metadata — only `version` and `flowTemplates` are read. */
interface FlowTemplateCatalogInput {
  version?: unknown
  flowTemplates?: Record<string, unknown>
}

export function loadSyncDefinitionFlowTemplateCatalog(
  projectRoot: string,
  relPath = DEFAULT_SYNC_DEFINITION_FLOW_TEMPLATES_PATH
): SyncDefinitionFlowTemplateCatalog {
  const metadataPath = resolve(projectRoot, DEFAULT_SYNC_METADATA_PATH)
  if (existsSync(metadataPath)) {
    return loadFlowTemplateCatalogFromMetadata(projectRoot)
  }

  const path = resolve(projectRoot, relPath)
  if (!existsSync(path)) {
    throw new Error(
      `Sync definition flow template catalog not found at ${relPath} or ${DEFAULT_SYNC_METADATA_PATH}.`
    )
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as FlowTemplateCatalogInput
  return parseFlowTemplateCatalog(parsed, relPath)
}

function loadFlowTemplateCatalogFromMetadata(projectRoot: string): SyncDefinitionFlowTemplateCatalog {
  const metadata = loadSyncMetadataArtifact(projectRoot)
  const raw = syncMetadataFlowTemplateCatalog(metadata)
  return parseFlowTemplateCatalog(raw, DEFAULT_SYNC_METADATA_PATH)
}
