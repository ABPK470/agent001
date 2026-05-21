/**
 * Phase 3 wiring — assemble the `system_law` resolvedFacts block.
 *
 * Pure inputs in, single string out. The orchestrator calls this once
 * per run and injects the result as a `system_law` message at the top
 * of system messages.
 *
 * Inputs:
 *   - `goal` — the user's request text, scanned for known-large objects.
 *   - `catalog` — live CatalogGraph (or null when no catalog is built).
 *   - `lineageMap` — view → ViewLineage entries (branch counts).
 *
 * Design:
 *   - Detection is case-insensitive and tolerant of bracket/quote noise
 *     (`[publish].[Revenue]` and `publish.revenue` both match).
 *   - Mirror existence is decided ONLY by live catalog membership, never
 *     by lineage.json — lineage describes shape, the catalog describes
 *     what currently exists in the environment.
 *   - When neither goal nor catalog contributes any large objects, we
 *     return an empty string so the caller skips the section entirely.
 *
 * @module
 */

import type { CatalogGraph, ViewLineage } from "@mia/agent"
import { buildResolvedFacts, type LargeObjectFact } from "@mia/agent"

/** Object names always worth surfacing when mentioned. Curated, short. */
const ALWAYS_TRACKED: readonly string[] = [
  "publish.revenue",
  "publish.balances",
  "fact.unotranspose",
  "dim.client",
  "dim.account",
]

/** Quick regex: `schema.Object` with optional bracket/quote noise. */
const OBJECT_TOKEN = /\b\[?(\w+)\]?\.\[?(\w+)\]?\b/g

/** Returns the lowercase `schema.object` tokens found in `text`. */
export function extractObjectTokens(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(OBJECT_TOKEN)) {
    const schema = m[1]!.toLowerCase()
    const obj = m[2]!.toLowerCase()
    out.add(`${schema}.${obj}`)
  }
  return [...out]
}

/**
 * Build the resolvedFacts string for `system_law` injection. Empty
 * string means "skip the section entirely".
 */
export function buildResolvedFactsBlock(input: {
  goal: string
  catalog: CatalogGraph | null
  lineageMap?: ReadonlyMap<string, ViewLineage>
  schemaFingerprint?: string | null
}): string {
  const { goal, catalog } = input
  const lineageMap = input.lineageMap ?? new Map<string, ViewLineage>()
  // Lineage map keys are case-preserved ("publish.Revenue"); we work in
  // lowercase, so build a lowercase index once.
  const lineageByLower = new Map<string, ViewLineage>()
  for (const [k, v] of lineageMap) lineageByLower.set(k.toLowerCase(), v)

  // Union: ALWAYS_TRACKED ∪ goal-mentioned tokens that live in catalog
  // or have a curated lineage entry. Stripping unknown tokens keeps the
  // block honest — we never claim a fact about a table that isn't there.
  const goalTokens = extractObjectTokens(goal)
  const candidates = new Set<string>(ALWAYS_TRACKED)
  for (const tok of goalTokens) candidates.add(tok)

  const largeObjects: LargeObjectFact[] = []
  for (const name of candidates) {
    const isGoalMentioned = goalTokens.includes(name)
    const inLineage = lineageByLower.has(name)
    const inCatalog = catalog?.tables.has(name) ?? false
    // Don't surface ALWAYS_TRACKED entries that aren't actually present
    // anywhere — that just adds noise for environments where the object
    // doesn't exist.
    if (!isGoalMentioned && !inCatalog && !inLineage) continue

    const hasPersistedMirror = catalog ? hasMirror(catalog, name) : false
    const lineage = lineageByLower.get(name)
    const branchCount = lineage?.sources.length
    largeObjects.push({
      name,
      hasPersistedMirror,
      ...(typeof branchCount === "number" && branchCount > 1 ? { branchCount } : {}),
    })
  }

  if (largeObjects.length === 0 && !input.schemaFingerprint) return ""

  return buildResolvedFacts({
    largeObjects,
    ...(input.schemaFingerprint ? { schemaFingerprint: input.schemaFingerprint } : {}),
  })
}

/**
 * `publish.revenue` → `publish.Revenue` style lookup against the
 * case-preserving lineage map. We try the original casing first, then
 * fall back to a case-insensitive scan because curated lineage uses
 * mixed case.
 */
function buildLineageKey(lowerName: string): string {
  // The lineage map's key is the original "publish.Revenue" string;
  // there are only a few entries, so a casing-tolerant lookup is fine.
  return lowerName
}

/**
 * Does the live catalog contain a `persistedView.<schema>.<object>`
 * mirror for the given lowercased `schema.object` token? Convention is
 * documented in `deploy/mssql/mymi-knowledge.md`.
 */
function hasMirror(catalog: CatalogGraph, lowerName: string): boolean {
  // Try both "persistedview.publish.revenue" and the curated bracketed
  // form. CatalogGraph keys are lowercased qualifiedNames.
  const probe = `persistedview.${lowerName}`
  for (const key of catalog.tables.keys()) {
    if (key.toLowerCase() === probe) return true
  }
  return false
}
