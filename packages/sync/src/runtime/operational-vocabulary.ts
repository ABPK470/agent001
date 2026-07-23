/**
 * Host-backed sync operational vocabulary for clarification detectors.
 */
import type { SyncEnvironmentRegistryHost, SyncProjectRootHost } from "../ports/index.js"
import { splitIdentifierTokens } from "../core/vocabulary/operational-vocabulary.js"
import { getEnvironments } from "./environments-registry.js"
import { listPublishedSyncDefinitions } from "../runtime/published-definitions.js"

export { splitIdentifierTokens }

export function buildSyncOperationalVocabulary(
  host: SyncProjectRootHost & SyncEnvironmentRegistryHost,
  projectRoot: string
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const def of listPublishedSyncDefinitions(host, projectRoot)) {
    out.add(def.id.toLowerCase())
    for (const token of splitIdentifierTokens(def.id)) out.add(token)
    for (const token of splitIdentifierTokens(def.displayName)) out.add(token)
  }
  for (const env of getEnvironments(host)) {
    out.add(env.name.toLowerCase())
    for (const token of splitIdentifierTokens(env.name)) out.add(token)
    for (const token of splitIdentifierTokens(env.displayName)) out.add(token)
  }
  return out
}

export function buildSyncOperationalVocabularyForHost(
  host: SyncProjectRootHost & SyncEnvironmentRegistryHost
): ReadonlySet<string> {
  const root = host.sync?.project?.dbProjectRoot
  if (!root || typeof root !== "string") return new Set()
  return buildSyncOperationalVocabulary(host, root)
}
