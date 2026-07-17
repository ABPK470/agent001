/**
 * Entity canonical resolution — map domain nouns to warehouse objects.
 *
 * First principles: when a user says "clients" or "months" in a data goal,
 * the deployment already knows the canonical dim table. Detectors should
 * prefer that grounding over alphabetical archive tables or ask_user blocks.
 *
 * Sources (in priority order):
 *   1. tenant.catalogBootstrap.canonicalQualifiedNames — explicit entity → table
 *   2. Ranked catalog search with schema-tier dominance on domain keywords
 *
 * @module
 */

import type { CatalogGraph } from "../../tools/catalog/graph/index.js"
import { getTenantConfig, type TenantConfig } from "../../domain/tenant/tenant-config.js"
import { isAnalyticEntityCandidate, schemaTierSortKey } from "../../tools/catalog/schema-role.js"

const PREFERRED_ANALYTIC_SCHEMAS = new Set(["publish", "persistedview", "dim", "fact", "list"])

/** Score gap — top candidate must lead second by this fraction to auto-resolve. */
const DOMINANCE_GAP = 0.3

/**
 * Look up a learned term→table mapping, tolerating singular/plural drift.
 * The stored subject is whatever lowercase noun the user was asked about
 * ("product" or "products"); a later goal may use the other form. We try the
 * token as-is, then strip a trailing "s", then add one, so a prior answer for
 * either form suppresses re-asking.
 */
function lookupLearned(learned: ReadonlyMap<string, string>, lc: string): string | undefined {
  const direct = learned.get(lc)
  if (direct) return direct
  if (lc.endsWith("s")) {
    const sing = learned.get(lc.slice(0, -1))
    if (sing) return sing
  }
  const plural = learned.get(`${lc}s`)
  if (plural) return plural
  return undefined
}

function schemaWeight(schema: string, tenant: TenantConfig): number {
  const lc = schema.toLowerCase()
  for (const entry of tenant.schemaRanking) {
    if (entry.schema.toLowerCase() === lc) return entry.weight
  }
  return 0
}

/**
 * Resolve a lowercase domain token to a canonical qualified table name when
 * tenant config, a learned prior clarification, or ranked catalog search
 * makes one object clearly dominant.
 *
 * Sources (in priority order):
 *   1. learned — durable term→table mappings from prior clarification
 *      answers (org-wide). A learned mapping wins outright when its table
 *      still exists in the catalog, so a subject the org already resolved
 *      never re-triggers `ask_user`.
 *   2. tenant.catalogBootstrap.canonicalQualifiedNames — explicit config.
 *   3. Ranked catalog search with schema-tier dominance on domain keywords.
 */
export function resolveCanonicalEntityTable(
  token: string,
  catalog: CatalogGraph,
  tenant: TenantConfig = getTenantConfig(),
  learned?: ReadonlyMap<string, string>
): string | null {
  const lc = token.toLowerCase()

  if (learned) {
    // The learned map is keyed by the exact lowercase subject the user was
    // asked about. A goal token can differ in pluralization ("product" vs
    // "products") and the old exact-only lookup missed, so the agent
    // re-asked about a term the org had already resolved. Try the token,
    // then its singular/plural variants, before falling through.
    const learnedQn = lookupLearned(learned, lc)
    if (learnedQn && catalog.getTable(learnedQn)) return learnedQn
  }

  const mapped =
    tenant.catalogBootstrap.canonicalQualifiedNames[lc] ??
    tenant.catalogBootstrap.canonicalQualifiedNames[`dim.${lc}`]
  if (mapped && catalog.getTable(mapped)) return mapped

  const isDomainWord = tenant.domainKeywords.some((k) => k.toLowerCase() === lc)
  if (!isDomainWord) return null

  const hits = catalog.search(lc, 5)
  if (hits.length === 0) return null

  const top = hits[0]!
  if (!PREFERRED_ANALYTIC_SCHEMAS.has(top.table.schema.toLowerCase())) return null
  if (top.score <= 0) return null

  if (hits.length === 1) return top.table.qualifiedName

  const second = hits[1]!
  const gap = second.score > 0 ? (top.score - second.score) / top.score : 1
  if (gap >= DOMINANCE_GAP) return top.table.qualifiedName

  // Tie-break: prefer higher schema tier weight when scores are close.
  const topWeight = schemaWeight(top.table.schema, tenant)
  const secondWeight = schemaWeight(second.table.schema, tenant)
  if (topWeight > secondWeight && topWeight >= 0) return top.table.qualifiedName

  return null
}

/**
 * True when the token should not trigger schema-match / term-undefined because
 * the deployment has a canonical analytic object for it.
 */
export function isCanonicallyGroundedEntity(
  token: string,
  catalog: CatalogGraph,
  tenant: TenantConfig = getTenantConfig(),
  learned?: ReadonlyMap<string, string>
): boolean {
  return resolveCanonicalEntityTable(token, catalog, tenant, learned) !== null
}

/**
 * Rank catalog table keys for a token using the same search engine as search_catalog.
 */
export function rankEntityTableCandidates(
  token: string,
  candidateKeys: Iterable<string>,
  catalog: CatalogGraph,
  limit: number,
  options: { goal?: string } = {}
): string[] {
  const goal = options.goal ?? ""
  const goalMentionsArchive = /\barchive\b/i.test(goal)
  const pinned = new Set(extractGoalQualifiedNames(goal))

  const allowed = new Set(
    [...candidateKeys]
      .map((k) => {
        const t = catalog.getTable(k)
        return t ? t.qualifiedName.toLowerCase() : k.toLowerCase()
      })
      .filter((keyLc) => {
        const t = catalog.getTable(keyLc)
        if (!t) return false
        return isAnalyticEntityCandidate(t.qualifiedName, {
          goalMentionsArchive,
          goalPinsQualifiedName: pinned.has(keyLc)
        })
      })
  )

  const hits = catalog.search(token, Math.max(limit * 3, 12))
  const ranked: string[] = []
  const seen = new Set<string>()

  for (const hit of hits) {
    const key = hit.table.qualifiedName
    const keyLc = key.toLowerCase()
    if (!allowed.has(keyLc)) continue
    if (!isAnalyticEntityCandidate(key, { goalMentionsArchive, goalPinsQualifiedName: pinned.has(keyLc) })) {
      continue
    }
    if (seen.has(keyLc)) continue
    seen.add(keyLc)
    ranked.push(key)
    if (ranked.length >= limit) break
  }

  if (ranked.length < limit) {
    const tenant = getTenantConfig()
    const rest = [...candidateKeys]
      .map((k) => catalog.getTable(k)?.qualifiedName ?? k)
      .filter((key) => {
        const keyLc = key.toLowerCase()
        if (seen.has(keyLc)) return false
        return isAnalyticEntityCandidate(key, { goalMentionsArchive, goalPinsQualifiedName: pinned.has(keyLc) })
      })
      .sort((a, b) => {
        const sa = a.includes(".") ? a.split(".")[0]! : a
        const sb = b.includes(".") ? b.split(".")[0]! : b
        return (
          schemaTierSortKey(sb, tenant.schemaRanking.find((e) => e.schema.toLowerCase() === sb.toLowerCase())?.weight ?? 0) -
          schemaTierSortKey(sa, tenant.schemaRanking.find((e) => e.schema.toLowerCase() === sa.toLowerCase())?.weight ?? 0)
        )
      })
    for (const key of rest) {
      const keyLc = key.toLowerCase()
      seen.add(keyLc)
      ranked.push(key)
      if (ranked.length >= limit) break
    }
  }

  return ranked
}

function extractGoalQualifiedNames(goal: string): string[] {
  const out: string[] = []
  const re = /\b([a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g
  for (const m of goal.matchAll(re)) {
    out.push(`${m[1]}.${m[2]}`.toLowerCase())
  }
  return out
}
