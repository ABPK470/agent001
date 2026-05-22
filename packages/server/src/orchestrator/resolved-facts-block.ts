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

import type { CatalogGraph } from "@mia/agent"
import {
    buildResolvedFacts,
    getTenantConfig,
    listLargeObjects,
    persistedMirrorOf,
    type LargeObjectFact,
} from "@mia/agent"

/**
 * Maximum number of catalog-derived large objects to include in the
 * resolvedFacts block even when the goal doesn't mention them. Acts as
 * the universal replacement for the prior ALWAYS_TRACKED hardcoding —
 * the top-N largest objects (by rowCount / viewSourceRows) are always
 * worth surfacing.
 */
const ALWAYS_TRACKED_TOPN = 5

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
  schemaFingerprint?: string | null
  /**
   * Tenant mirror-schema override. When omitted, falls back to the
   * tenant config; when explicitly null, mirror detection is disabled.
   */
  mirrorSchema?: string | null
}): string {
  const { goal, catalog } = input
  const mirrorSchema = input.mirrorSchema !== undefined
    ? input.mirrorSchema
    : getTenantConfig().mirrorSchema

  // Union: top-N largest objects (catalog-derived) ∪ goal-mentioned tokens
  // that live in catalog. Stripping unknown tokens keeps the block honest —
  // we never claim a fact about a table that isn't there.
  const goalTokens = extractObjectTokens(goal)
  const candidates = new Set<string>()
  if (catalog) {
    // listLargeObjects() returns lowercased qualifiedNames already.
    const top = [...listLargeObjects({ accessor: () => catalog })].slice(0, ALWAYS_TRACKED_TOPN)
    for (const name of top) candidates.add(name)
  }
  for (const tok of goalTokens) candidates.add(tok)

  const largeObjects: LargeObjectFact[] = []
  for (const name of candidates) {
    const isGoalMentioned = goalTokens.includes(name)
    const inCatalog = catalog?.tables.has(name) ?? false
    // Don't surface ALWAYS_TRACKED entries that aren't actually present
    // anywhere — that just adds noise for environments where the object
    // doesn't exist.
    if (!isGoalMentioned && !inCatalog) continue

    const hasPersistedMirror = catalog ? hasMirror(catalog, name, mirrorSchema) : false
    largeObjects.push({
      name,
      hasPersistedMirror,
    })
  }

  if (largeObjects.length === 0 && !input.schemaFingerprint) return ""

  return buildResolvedFacts({
    largeObjects,
    ...(input.schemaFingerprint ? { schemaFingerprint: input.schemaFingerprint } : {}),
  })
}

/**
 * Does the live catalog contain a `<mirrorSchema>.<schema>.<object>`
 * mirror for the given lowercased `schema.object` token? Mirror schema
 * comes from tenant config; when unset, no object is ever flagged as
 * having a mirror. Convention is documented per-deployment.
 */
function hasMirror(
  catalog: CatalogGraph,
  lowerName: string,
  mirrorSchema: string | null,
): boolean {
  if (!mirrorSchema) return false
  return persistedMirrorOf(lowerName, {
    mirrorSchema,
    accessor: () => catalog,
  }) !== null
}
