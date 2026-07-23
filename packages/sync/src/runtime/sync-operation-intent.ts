/**
 * Host-backed sync operation intent parsing.
 */
import type { SyncEnvironmentRegistryHost, SyncProjectRootHost } from "../ports/index.js"
import {
  parseSyncOperationIntent,
  type SyncOperationIntent
} from "../core/intent/sync-operation-intent.js"
import { getEnvironments } from "./environments-registry.js"
import { listPublishedSyncDefinitions } from "../runtime/published-definitions.js"

export function parseSyncOperationIntentForHost(
  goal: string,
  host: SyncProjectRootHost & SyncEnvironmentRegistryHost
): SyncOperationIntent | null {
  const root = host.sync?.project?.dbProjectRoot
  if (!root) return null
  const definitions = listPublishedSyncDefinitions(host, root)
  const environments = getEnvironments(host)
  if (definitions.length === 0 || environments.length === 0) return null
  return parseSyncOperationIntent(goal, definitions, environments)
}

export {
  formatSyncOperationIntentBlock,
  parseSyncOperationIntent,
  type SyncOperationIntent
} from "../core/intent/sync-operation-intent.js"
