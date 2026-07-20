/**
 * Assemble the `system_law` resolvedFacts block for a run.
 *
 * First principles: facts about *this goal against this environment* —
 * not an ambient dump of the warehouse’s biggest tables. Dumping top-N
 * large objects into every prompt (including “Hi”) looks like cross-run
 * memory leakage and pollutes unrelated chats.
 *
 * Include only:
 *   - `schema.object` tokens that appear in the goal text, and
 *   - objects resolved by goal-data-anchors from the goal + catalog.
 *
 * Mirror existence is decided ONLY by live catalog membership.
 * Empty string → caller skips the section entirely.
 *
 * @module
 */

import type { CatalogGraph } from "@mia/agent"
import {
  buildResolvedFacts,
  getTenantConfig,
  persistedMirrorOf,
  resolveGoalDataAnchors,
  type LargeObjectFact
} from "@mia/agent"
import { listTableVerdicts } from "../../../../infra/persistence/memory.js"

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
  const mirrorSchema = input.mirrorSchema !== undefined ? input.mirrorSchema : getTenantConfig().mirrorSchema

  const goalTokens = extractObjectTokens(goal)
  const candidates = new Set<string>()
  for (const tok of goalTokens) candidates.add(tok)
  if (catalog) {
    for (const anchor of resolveGoalDataAnchors(goal, catalog)) {
      candidates.add(anchor.qualifiedName.toLowerCase())
    }
  }

  const largeObjects: LargeObjectFact[] = []
  for (const name of candidates) {
    const inCatalog = catalog?.getTable(name) != null
    // Goal-mentioned tokens that aren't in catalog still get a line so the
    // model sees "you named X; it isn't here" — only when the goal said so.
    if (!inCatalog && !goalTokens.includes(name)) continue

    const hasPersistedMirror = catalog ? hasMirror(catalog, name, mirrorSchema) : false
    const fanInRows = catalog ? (catalog.viewSourceRows.get(name) ?? 0) : 0
    const structuralRank = catalog ? structuralRankIn(catalog, name) : undefined
    largeObjects.push({
      name,
      hasPersistedMirror,
      ...(fanInRows > 0 ? { fanInRows } : {}),
      ...(typeof structuralRank === "number" ? { structuralRank } : {})
    })
  }

  // Overlay durable verdicts from memory when available (prior reflection).
  if (largeObjects.length > 0) {
    try {
      const verdicts = listTableVerdicts({ qnames: largeObjects.map((o) => o.name) })
      if (verdicts.length > 0) {
        const byName = new Map(verdicts.map((v) => [v.qname.toLowerCase(), v.role]))
        for (let i = 0; i < largeObjects.length; i++) {
          const role = byName.get(largeObjects[i]!.name.toLowerCase())
          if (role) largeObjects[i] = { ...largeObjects[i]!, verdictRole: role }
        }
      }
    } catch {
      // memory unavailable — proceed without verdicts.
    }
  }

  // No goal-relevant objects → omit the block entirely (including fingerprint-
  // only noise on greetings / empty goals).
  if (largeObjects.length === 0) return ""

  return buildResolvedFacts({
    largeObjects,
    ...(input.schemaFingerprint ? { schemaFingerprint: input.schemaFingerprint } : {})
  })
}

/**
 * Structural rank of `lowerName` among siblings sharing its lowercase
 * name prefix in the live catalog. 1 = the bare canonical (no suffix),
 * 2+ = suffixed sibling subsets ordered by name length (shortest first).
 * Returns undefined when the catalog has no siblings to compare.
 */
function structuralRankIn(catalog: CatalogGraph, lowerName: string): number | undefined {
  const target = catalog.getTable(lowerName)
  if (!target) return undefined
  const targetSchema = target.schema.toLowerCase()
  const targetBase = target.name.toLowerCase()
  const minPrefixLen = Math.max(3, Math.floor(targetBase.length / 2))
  const prefix = targetBase.slice(0, minPrefixLen)
  const siblings: string[] = []
  for (const [, t] of catalog.tables) {
    if (t.schema.toLowerCase() !== targetSchema) continue
    if (!t.name.toLowerCase().startsWith(prefix)) continue
    siblings.push(t.name.toLowerCase())
  }
  if (siblings.length < 2) return undefined
  siblings.sort((a, b) => a.length - b.length || a.localeCompare(b))
  const idx = siblings.indexOf(targetBase)
  return idx >= 0 ? idx + 1 : undefined
}

function hasMirror(catalog: CatalogGraph, lowerName: string, mirrorSchema: string | null): boolean {
  if (!mirrorSchema) return false
  return (
    persistedMirrorOf(lowerName, {
      mirrorSchema,
      accessor: () => catalog
    }) !== null
  )
}
