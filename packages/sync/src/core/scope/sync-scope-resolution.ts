/**
 * Resolve natural-language scope queries against published sync definitions.
 *
 * Authority is always the definition bundle — ids, display names, and table
 * names are indexed at runtime. No hardcoded entity vocabulary.
 */

import type { PublishedSyncDefinition } from "@mia/shared-types"
import { splitIdentifierTokens } from "../vocabulary/operational-vocabulary.js"

export interface SyncScopeMatch {
  readonly entityType: string
  readonly displayName: string
  readonly score: number
  /** When the query names specific tables, subset to report on (full preview still runs). */
  readonly tables: readonly string[] | null
  readonly rootTable: string
  readonly rationale: string
}

export interface SyncScopeResolution {
  readonly query: string
  readonly tokens: readonly string[]
  readonly matches: readonly SyncScopeMatch[]
  readonly ambiguous: boolean
  readonly top: SyncScopeMatch | null
}

interface IndexedTerm {
  readonly term: string
  readonly weight: number
  readonly kind: "id" | "display" | "table" | "tableBase"
}

function normalizeScopeToken(token: string): string {
  return token.toLowerCase().trim()
}

function scopeTokensFromQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(normalizeScopeToken)
    .filter((t) => t.length >= 3)
}

function foldToken(token: string): string {
  const t = token.toLowerCase()
  if (t.endsWith("ies") && t.length > 4) return `${t.slice(0, -3)}y`
  if (t.endsWith("es") && t.length > 4) return t.slice(0, -2)
  if (t.endsWith("s") && t.length > 4) return t.slice(0, -1)
  return t
}

function termMatchesQuery(queryToken: string, candidate: string): boolean {
  const q = foldToken(queryToken)
  const c = foldToken(candidate)
  if (q.length < 3 || c.length < 3) return false
  if (q === c) return true
  if (q.startsWith(c) || c.startsWith(q)) return true
  return false
}

function tableBaseName(qualified: string): string {
  const parts = qualified.split(".")
  return parts[parts.length - 1] ?? qualified
}

function indexDefinition(def: PublishedSyncDefinition): IndexedTerm[] {
  const terms: IndexedTerm[] = []
  const add = (raw: string, weight: number, kind: IndexedTerm["kind"]): void => {
    const term = raw.toLowerCase()
    if (term.length < 2) return
    terms.push({ term, weight, kind })
    for (const token of splitIdentifierTokens(raw)) {
      if (token.length >= 2) terms.push({ term: token, weight, kind })
    }
  }

  add(def.id, 3, "id")
  add(def.displayName, 3, "display")
  for (const table of def.metadata.tables) {
    add(table.name, 2, "table")
    add(tableBaseName(table.name), 1.5, "tableBase")
  }
  return terms
}

function scoreDefinition(def: PublishedSyncDefinition, queryTokens: readonly string[]): SyncScopeMatch | null {
  if (queryTokens.length === 0) return null

  const indexed = indexDefinition(def)
  let score = 0
  let maxPossible = 0
  const matchedTableNames = new Set<string>()
  const rationales: string[] = []

  for (const queryToken of queryTokens) {
    maxPossible += 3
    let best = 0
    let bestKind: IndexedTerm["kind"] | null = null
    let bestTable: string | null = null

    for (const entry of indexed) {
      if (!termMatchesQuery(queryToken, entry.term)) continue
      if (entry.weight > best) {
        best = entry.weight
        bestKind = entry.kind
        bestTable = entry.kind === "table" || entry.kind === "tableBase" ? entry.term : null
      }
    }

    if (best === 0) continue
    score += best
    if (bestKind === "id") rationales.push(`id/display "${queryToken}"`)
    else if (bestKind === "display") rationales.push(`display name "${queryToken}"`)
    else if (bestTable) {
      matchedTableNames.add(bestTable)
      rationales.push(`table ${bestTable}`)
    }
  }

  if (score === 0) return null

  const normalizedScore = maxPossible > 0 ? score / maxPossible : 0
  const allTables = def.metadata.tables.map((t) => t.name)
  const tableHits = allTables.filter((name) => {
    const base = tableBaseName(name).toLowerCase()
    return [...matchedTableNames].some(
      (m) => name.toLowerCase() === m || base === m || termMatchesQuery(m, base)
    )
  })

  const tables =
    tableHits.length > 0 && tableHits.length < allTables.length ? tableHits : null

  const rationale =
    rationales.length > 0
      ? [...new Set(rationales)].slice(0, 4).join("; ")
      : "definition metadata match"

  return {
    entityType: def.id,
    displayName: def.displayName,
    score: Math.min(1, normalizedScore),
    tables,
    rootTable: def.rootTable,
    rationale
  }
}

const AMBIGUITY_SCORE_GAP = 0.12

export function resolveSyncScope(
  query: string,
  definitions: readonly PublishedSyncDefinition[]
): SyncScopeResolution {
  const trimmed = query.trim()
  const tokens = scopeTokensFromQuery(trimmed)
  const matches = definitions
    .map((def) => scoreDefinition(def, tokens))
    .filter((m): m is SyncScopeMatch => m !== null)
    .sort((a, b) => b.score - a.score)

  const top = matches[0] ?? null
  const second = matches[1]
  const ambiguous =
    matches.length > 1 &&
    top !== null &&
    second !== undefined &&
    top.score - second.score < AMBIGUITY_SCORE_GAP

  return {
    query: trimmed,
    tokens,
    matches,
    ambiguous,
    top: ambiguous ? null : top
  }
}

export function formatSyncScopeResolution(resolution: SyncScopeResolution): string {
  const lines: string[] = [`Scope query: "${resolution.query}"`]
  if (resolution.tokens.length > 0) {
    lines.push(`Tokens: ${resolution.tokens.join(", ")}`)
  }
  if (resolution.matches.length === 0) {
    lines.push("No published sync definitions matched this scope.")
    lines.push("Call list_sync_definitions to see what is syncable.")
    return lines.join("\n")
  }
  lines.push("Matches (ranked):")
  for (const m of resolution.matches.slice(0, 8)) {
    const tableNote =
      m.tables && m.tables.length > 0
        ? ` · tables: ${m.tables.join(", ")}`
        : " · all recipe tables"
    lines.push(
      `  • ${m.entityType} (${m.displayName}) score=${m.score.toFixed(2)} · root ${m.rootTable}${tableNote}`
    )
    lines.push(`    ${m.rationale}`)
  }
  if (resolution.matches.length > 8) {
    lines.push(`  … ${resolution.matches.length - 8} more`)
  }
  if (resolution.ambiguous) {
    lines.push("")
    lines.push(
      "Ambiguous — multiple definitions match. Use ask_user to pick entityType (and optional tables filter), then sync_diff_scan or sync_preview."
    )
  } else if (resolution.top) {
    lines.push("")
    lines.push(
      `Use entityType="${resolution.top.entityType}"` +
        (resolution.top.tables?.length
          ? ` with tables=[${resolution.top.tables.map((t) => `"${t}"`).join(", ")}]`
          : "") +
        " in sync_diff_scan or sync_preview."
    )
  }
  return lines.join("\n")
}
