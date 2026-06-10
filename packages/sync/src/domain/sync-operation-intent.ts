/**
 * Deterministic parsing of natural-language ABI sync preview goals.
 *
 * Pattern: (sync|synchronize) + published entity type + instance name/id +
 * from <env> to <env>. Entity types and environments come from runtime
 * registries — not hardcoded lists.
 */

import { getEnvironments, type SyncEnvironment } from "./environments.js"
import {
  listPublishedSyncDefinitions,
  type PublishedSyncDefinition
} from "./published-definitions.js"
import type { SyncEnvironmentRegistryHost, SyncProjectRootHost } from "../ports/index.js"
import { splitIdentifierTokens } from "./operational-vocabulary.js"

export interface SyncOperationIntent {
  readonly entityType: string
  readonly entityQuery: string | null
  readonly entityId: string | null
  readonly source: string
  readonly target: string
  /** Goal tokens that name sync parameters — not warehouse catalog objects. */
  readonly reservedTokens: ReadonlySet<string>
}

const SYNC_VERB_RE = /\b(sync|synchroni[sz]e|synchroni[sz]ation|synchroni[sz]ing)\b/i

const ROUTE_RE = /\bfrom\s+([a-zA-Z][a-zA-Z0-9_-]*)\s+to\s+([a-zA-Z][a-zA-Z0-9_-]*)\b/i

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function goalTokensLower(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2)
}

/** Map unambiguous alias tokens → published definition id. */
export function buildEntityTypeAliasMap(
  definitions: readonly PublishedSyncDefinition[]
): ReadonlyMap<string, string> {
  const aliasToDefs = new Map<string, Set<string>>()
  const add = (alias: string, defId: string): void => {
    const key = alias.toLowerCase()
    if (key.length < 2) return
    let bucket = aliasToDefs.get(key)
    if (!bucket) {
      bucket = new Set()
      aliasToDefs.set(key, bucket)
    }
    bucket.add(defId)
  }

  for (const def of definitions) {
    add(def.id, def.id)
    for (const token of splitIdentifierTokens(def.id)) add(token, def.id)
    for (const token of splitIdentifierTokens(def.displayName)) add(token, def.id)
  }

  const out = new Map<string, string>()
  for (const [alias, ids] of aliasToDefs) {
    if (ids.size === 1) out.set(alias, [...ids][0]!)
  }
  return out
}

function resolveEnvironmentName(token: string, environments: readonly SyncEnvironment[]): string | null {
  const lower = token.toLowerCase()
  for (const env of environments) {
    if (env.name.toLowerCase() === lower) return env.name
    if (env.displayName.toLowerCase() === lower) return env.name
    for (const part of splitIdentifierTokens(env.displayName)) {
      if (part === lower) return env.name
    }
  }
  return null
}

function findEntityTypeAlias(
  goal: string,
  aliasMap: ReadonlyMap<string, string>
): { alias: string; entityType: string } | null {
  const aliases = [...aliasMap.keys()].sort((a, b) => b.length - a.length)
  for (const alias of aliases) {
    if (new RegExp(`\\b${escapeRe(alias)}\\b`, "i").test(goal)) {
      return { alias, entityType: aliasMap.get(alias)! }
    }
  }
  return null
}

function extractInstanceRef(goal: string, entityAlias: string): string | null {
  const re = new RegExp(`\\b${escapeRe(entityAlias)}\\b\\s+(.+?)\\s+from\\b`, "is")
  const match = goal.match(re)
  if (!match?.[1]) return null
  const raw = match[1].trim()
  return raw.length > 0 ? raw : null
}

function buildReservedTokens(
  goal: string,
  entityAlias: string,
  instanceRef: string | null,
  source: string,
  target: string,
  vocabulary: ReadonlySet<string>
): ReadonlySet<string> {
  const out = new Set<string>(vocabulary)
  out.add(entityAlias.toLowerCase())
  out.add(source.toLowerCase())
  out.add(target.toLowerCase())
  for (const token of goalTokensLower(goal)) {
    if (token === "sync" || token.startsWith("synchron")) out.add(token)
  }
  if (instanceRef) {
    for (const token of goalTokensLower(instanceRef)) out.add(token)
    out.add(instanceRef.toLowerCase().replace(/\s+/g, ""))
  }
  return out
}

export function parseSyncOperationIntent(
  goal: string,
  definitions: readonly PublishedSyncDefinition[],
  environments: readonly SyncEnvironment[]
): SyncOperationIntent | null {
  const text = goal.trim()
  if (!text || !SYNC_VERB_RE.test(text)) return null

  const routeMatch = text.match(ROUTE_RE)
  if (!routeMatch?.[1] || !routeMatch[2]) return null

  const source = resolveEnvironmentName(routeMatch[1], environments)
  const target = resolveEnvironmentName(routeMatch[2], environments)
  if (!source || !target) return null

  const aliasMap = buildEntityTypeAliasMap(definitions)
  const entityHit = findEntityTypeAlias(text, aliasMap)
  if (!entityHit) return null

  const instanceRef = extractInstanceRef(text, entityHit.alias)
  let entityQuery: string | null = instanceRef
  let entityId: string | null = null
  if (instanceRef && /^\d+$/.test(instanceRef.replace(/\s+/g, ""))) {
    entityId = instanceRef.replace(/\s+/g, "")
    entityQuery = null
  }

  const vocabulary = new Set<string>()
  for (const def of definitions) {
    vocabulary.add(def.id.toLowerCase())
    for (const token of splitIdentifierTokens(def.id)) vocabulary.add(token)
  }
  for (const env of environments) {
    vocabulary.add(env.name.toLowerCase())
    for (const token of splitIdentifierTokens(env.name)) vocabulary.add(token)
    for (const token of splitIdentifierTokens(env.displayName)) vocabulary.add(token)
  }

  const reservedTokens = buildReservedTokens(
    text,
    entityHit.alias,
    instanceRef,
    source,
    target,
    vocabulary
  )

  return {
    entityType: entityHit.entityType,
    entityQuery,
    entityId,
    source,
    target,
    reservedTokens
  }
}

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

export function formatSyncOperationIntentBlock(intent: SyncOperationIntent): string {
  const lines = [
    "<sync_operation_intent>",
    "Parsed deterministically: the user wants an ABI environment sync preview.",
    `entityType: ${intent.entityType}`,
    `route: ${intent.source} → ${intent.target}`
  ]
  if (intent.entityId) {
    lines.push(`entityId: ${intent.entityId}`)
  } else if (intent.entityQuery) {
    lines.push(
      `entity instance name: "${intent.entityQuery}" — resolve with search_sync_entities { entityType, source, q } on the source environment.`
    )
    lines.push(
      "This is a row label in the sync recipe root table (e.g. core.Contract.name), NOT a warehouse catalog table."
    )
  } else {
    lines.push("entity instance: not specified — use search_sync_entities if the user gave a name.")
  }
  lines.push(
    "Do NOT call ask_user to pick catalog tables for the entity name or entity type. Do NOT use search_catalog for sync lookup."
  )
  lines.push("Workflow: search_sync_entities (when name given) → sync_preview → present plan and STOP.")
  lines.push("</sync_operation_intent>")
  return lines.join("\n")
}
