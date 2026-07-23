/**
 * Load flow recipe catalog from deploy sync-metadata.json (flows).
 * In-memory shape keeps key `flowTemplates` for SyncDefinitionFlowTemplateCatalog.
 */

import {
  parseFlowTemplateCatalog,
  type SyncDefinitionFlowTemplateCatalog,
} from "../core/flow/sync-definition-flow-templates.js"
import {
  DEFAULT_SYNC_METADATA_PATH,
  loadSyncMetadataArtifact,
  syncMetadataFlowTemplateCatalog,
} from "./artifacts/load-sync-metadata-artifact.js"

export function loadSyncDefinitionFlowTemplateCatalog(
  projectRoot: string,
): SyncDefinitionFlowTemplateCatalog {
  const metadata = loadSyncMetadataArtifact(projectRoot)
  const raw = syncMetadataFlowTemplateCatalog(metadata)
  return parseFlowTemplateCatalog(raw, DEFAULT_SYNC_METADATA_PATH)
}
