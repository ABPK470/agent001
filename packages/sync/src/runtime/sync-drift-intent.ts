/**
 * Host-backed sync drift intent parsing.
 */
import type { SyncEnvironmentRegistryHost, SyncProjectRootHost } from "../ports/index.js"
import {
  parseSyncDriftIntent,
  type SyncDriftIntent
} from "../core/intent/sync-drift-intent.js"
import { getEnvironments } from "./environments-registry.js"
import { listPublishedSyncDefinitions } from "../runtime/published-definitions.js"

export function parseSyncDriftIntentForHost(
  goal: string,
  host: SyncProjectRootHost & SyncEnvironmentRegistryHost
): SyncDriftIntent | null {
  const root = host.sync?.project?.dbProjectRoot
  if (!root) return null
  const definitions = listPublishedSyncDefinitions(host, root)
  const environments = getEnvironments(host)
  if (environments.length < 2) return null
  return parseSyncDriftIntent(goal, definitions, environments)
}

export {
  formatSyncDriftIntentBlock,
  parseSyncDriftIntent,
  type SyncDriftIntent
} from "../core/intent/sync-drift-intent.js"
