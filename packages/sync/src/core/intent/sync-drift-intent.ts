/**
 * Deterministic parsing of cross-environment "what is out of sync" goals.
 *
 * Extracts source/target environments and a scope query, then resolves scope
 * against published definitions (no hardcoded entity vocabulary).
 */

import type { SyncEnvironment } from "../../domain/environments.js"
import type { PublishedSyncDefinition } from "@mia/shared-types"
import {
  formatSyncScopeResolution,
  resolveSyncScope,
  type SyncScopeMatch,
  type SyncScopeResolution
} from "../scope/sync-scope-resolution.js"

export interface SyncDriftIntent {
  readonly source: string
  readonly target: string
  readonly scopeQuery: string | null
  readonly scope: SyncScopeResolution | null
}

const DRIFT_RE =
  /\bout\s+of\s+sync\b|\bnot\s+in\s+sync\b|\b(?:meta)?data\s+drift\b|\bdrift(?:ed|ing|s)?\b|\bdiverg(?:e|ent|ence|ing)?\b|\bmismatch(?:ed|es|ing)?\b|\bdesync(?:ed|hronized)?\b/i

const BETWEEN_RE =
  /\bbetween\s+([a-zA-Z][a-zA-Z0-9_\s()-]*?)\s+and\s+([a-zA-Z][a-zA-Z0-9_\s()-]*?)(?:\?|\.|$)/i

const FROM_TO_RE = /\bfrom\s+([a-zA-Z][a-zA-Z0-9_-]+)\s+to\s+([a-zA-Z][a-zA-Z0-9_-]+)\b/i

const VS_RE = /\b([a-zA-Z][a-zA-Z0-9_-]+)\s+(?:vs\.?|versus)\s+([a-zA-Z][a-zA-Z0-9_-]+)\b/i

const STRIP_NOISE_RE =
  /\b(what|which|show|tell|me|please|just|analyze|analyse|check|find|list|are|is|the|a|an|all|any|some|how|many)\b/gi

const STRIP_DRIFT_RE =
  /\b(out\s+of\s+sync|not\s+in\s+sync|(?:meta)?data\s+drift|drift(?:ed|ing|s)?|diverg(?:e|ent|ence|ing)?|mismatch(?:ed|es|ing)?|desync(?:ed|hronized)?)\b/gi

const STRIP_ENV_PHRASING_RE =
  /\b(between|from|to|vs\.?|versus|source|target|environ(?:ment)?s?)\b/gi

function stripEnvAnnotation(token: string): string {
  return token
    .replace(/\(\s*source\s*\)/gi, "")
    .replace(/\(\s*target\s*\)/gi, "")
    .trim()
}

function resolveEnvironmentName(token: string, environments: readonly SyncEnvironment[]): string | null {
  const cleaned = stripEnvAnnotation(token).trim()
  if (!cleaned) return null
  const lower = cleaned.toLowerCase()
  for (const env of environments) {
    if (env.name.toLowerCase() === lower) return env.name
    if (env.displayName.toLowerCase() === lower) return env.name
  }
  return null
}

function extractEnvPair(
  text: string,
  environments: readonly SyncEnvironment[]
): { source: string; target: string; remainder: string } | null {
  const between = text.match(BETWEEN_RE)
  if (between?.[1] && between[2]) {
    const source = resolveEnvironmentName(between[1], environments)
    const target = resolveEnvironmentName(between[2], environments)
    if (source && target) {
      const remainder = text.replace(between[0], " ")
      return { source, target, remainder }
    }
  }

  const fromTo = text.match(FROM_TO_RE)
  if (fromTo?.[1] && fromTo[2]) {
    const source = resolveEnvironmentName(fromTo[1], environments)
    const target = resolveEnvironmentName(fromTo[2], environments)
    if (source && target) {
      const remainder = text.replace(fromTo[0], " ")
      return { source, target, remainder }
    }
  }

  const vs = text.match(VS_RE)
  if (vs?.[1] && vs[2]) {
    const source = resolveEnvironmentName(vs[1], environments)
    const target = resolveEnvironmentName(vs[2], environments)
    if (source && target) {
      const remainder = text.replace(vs[0], " ")
      return { source, target, remainder }
    }
  }

  return null
}

function extractScopeQuery(remainder: string, environments: readonly SyncEnvironment[]): string | null {
  let text = remainder
  for (const env of environments) {
    text = text.replace(new RegExp(`\\b${env.name}\\b`, "gi"), " ")
    text = text.replace(new RegExp(`\\b${env.displayName}\\b`, "gi"), " ")
  }
  text = text
    .replace(STRIP_NOISE_RE, " ")
    .replace(STRIP_DRIFT_RE, " ")
    .replace(STRIP_ENV_PHRASING_RE, " ")
    .replace(/[()?,:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length >= 3 ? text : null
}

export function parseSyncDriftIntent(
  goal: string,
  definitions: readonly PublishedSyncDefinition[],
  environments: readonly SyncEnvironment[]
): SyncDriftIntent | null {
  const text = goal.trim()
  if (!text || !DRIFT_RE.test(text)) return null

  const route = extractEnvPair(text, environments)
  if (!route) return null

  const scopeQuery = extractScopeQuery(route.remainder, environments)
  const scope =
    scopeQuery && definitions.length > 0 ? resolveSyncScope(scopeQuery, definitions) : null

  return {
    source: route.source,
    target: route.target,
    scopeQuery,
    scope
  }
}


export function formatSyncDriftIntentBlock(intent: SyncDriftIntent): string {
  const lines = [
    "<sync_drift_intent>",
    "Parsed deterministically: cross-environment ABI metadata diff (hash preview engine — not ad-hoc SQL or the background proposer).",
    `route: ${intent.source} → ${intent.target}`
  ]

  if (intent.scopeQuery) {
    lines.push(`scope query: "${intent.scopeQuery}"`)
  } else {
    lines.push("scope query: (unspecified — call list_sync_definitions then resolve_sync_scope or ask_user what to compare)")
  }

  if (intent.scope) {
    lines.push("")
    lines.push(formatSyncScopeResolution(intent.scope))
    if (intent.scope.top) {
      const t: SyncScopeMatch = intent.scope.top
      lines.push("")
      lines.push(
        `Call sync_diff_scan { entityType: "${t.entityType}", source: "${intent.source}", target: "${intent.target}"` +
          (t.tables?.length ? `, tables: [${t.tables.map((x) => `"${x}"`).join(", ")}]` : "") +
          " } for bulk diff, or sync_preview when the user named one instance id."
      )
    } else if (intent.scope.ambiguous) {
      lines.push("")
      lines.push(
        "Scope is ambiguous — call resolve_sync_scope or ask_user to pick entityType before sync_diff_scan."
      )
    } else if (intent.scope.matches.length === 0) {
      lines.push("")
      lines.push("Call list_sync_definitions to discover published entity types, then resolve_sync_scope.")
    }
  } else if (intent.scopeQuery) {
    lines.push("")
    lines.push(`Call resolve_sync_scope { q: "${intent.scopeQuery}" } before sync_diff_scan.`)
  }

  lines.push("Do NOT use query_mssql for cross-env row reconciliation.")
  lines.push("</sync_drift_intent>")
  return lines.join("\n")
}
