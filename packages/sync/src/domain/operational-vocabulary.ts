/**
 * Vocabulary for operational workflows whose parameters live outside the
 * warehouse catalog namespace (published sync definitions, environments).
 *
 * Fed into clarification detectors so goal tokens like a definition id or
 * env name are not treated as ambiguous catalog table names.
 */

import { getEnvironments } from "./environments.js"
import { listPublishedSyncDefinitions } from "./published-definitions.js"
import type { SyncEnvironmentRegistryHost, SyncProjectRootHost } from "../ports/index.js"

function splitIdentifierTokens(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

/**
 * Tokens that name sync workflow parameters (definition ids, env names).
 * Built from the same registries the sync tools use — no hardcoded entity list.
 */
export function buildSyncOperationalVocabulary(
  host: SyncProjectRootHost & SyncEnvironmentRegistryHost,
  projectRoot: string
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const def of listPublishedSyncDefinitions(host, projectRoot)) {
    out.add(def.id.toLowerCase())
    for (const token of splitIdentifierTokens(def.id)) out.add(token)
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
