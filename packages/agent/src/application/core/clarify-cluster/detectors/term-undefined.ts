// term-undefined detector — "this capitalised business word is not in the database".
//
// Fires (block-severity) when the user goal contains a capitalised
// noun-phrase that does NOT match any catalog identifier (table, column,
// schema) AND is not listed in tenant.routingKeywords.domain. Without
// that context the agent is liable to invent a meaning ("Corporate" =
// some plausible-sounding column it has never seen). Ask instead.
//
// Pure function of (goal, catalog, tenant). No I/O, no LLM.

import type { TenantConfig } from "../../../shell/tenant-config.js"
import type { CatalogGraph } from "../../../../tools/index.js"
import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"
import { mergeReservedTokens } from "./reserved-tokens.js"
import { isStopword } from "./stopwords.js"

const VERSION = "1.0.0"

/**
 * Matches a capitalised noun-phrase: one capitalised word optionally
 * followed by up to two more capitalised words (e.g. "Net Revenue",
 * "Corporate Banking", "Daily Stock Reconciliation"). Anchored at word
 * boundaries on both sides so it does not split URLs or identifiers.
 *
 * Deliberately NOT global-anchored with ^ — we accept matches anywhere
 * in the sentence, including mid-sentence proper-noun-style usages.
 */
const CAPITALISED_PHRASE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/g

/**
 * Words that frequently start a sentence in English imperatives or
 * questions and would otherwise be flagged as undefined business terms.
 * Strictly framing language — never a business subject.
 */
const SENTENCE_STARTERS: ReadonlySet<string> = new Set([
  "Show",
  "Give",
  "Tell",
  "Find",
  "List",
  "Get",
  "Fetch",
  "Return",
  "Display",
  "Please",
  "Thanks",
  "Thank",
  "Hi",
  "Hello",
  "Hey",
  "How",
  "What",
  "Which",
  "Who",
  "Where",
  "When",
  "Why",
  "Can",
  "Could",
  "Would",
  "Should",
  "Will",
  "Do",
  "Does",
  "Did",
  "Is",
  "Are",
  "Was",
  "Were",
  "I",
  "We",
  "You",
  "They",
  "The",
  "A",
  "An",
  "Let",
  "Make"
])

export const termUndefinedDetector: Detector = {
  id: "term-undefined",
  version: VERSION,

  detect(ctx) {
    if (!ctx.catalog) return []
    const reserved = mergeReservedTokens(ctx)
    const out = []
    const seen = new Set<string>()
    const matches = ctx.goal.match(CAPITALISED_PHRASE) ?? []
    for (const phrase of matches) {
      // skip single-word sentence starters ("Show", "How", "Please", …)
      if (!phrase.includes(" ") && SENTENCE_STARTERS.has(phrase)) continue
      const lc = phrase.toLowerCase()
      if (seen.has(lc)) continue
      seen.add(lc)
      // skip if any of its tokens is a stopword AND the phrase is single-word
      if (!phrase.includes(" ") && isStopword(phrase)) continue
      if (isKnownInCatalog(lc, ctx.catalog)) continue
      if (isKnownToTenant(lc, ctx.tenant)) continue
      if (reserved?.has(lc)) continue
      const phraseTokens = lc.split(/\s+/).filter((t) => t.length > 0)
      if (phraseTokens.some((t) => reserved?.has(t))) continue
      out.push({
        id: makeFindingId("term-undefined", lc),
        kind: "term-undefined" as const,
        severity: "block" as const,
        subject: phrase,
        reasoning: `"${phrase}" is not a table, view, column, schema, or configured domain term in this database. The agent has no grounding for what it refers to.`,
        suggestedQuestion: `I don't recognise "${phrase}" in this database. Could you point me at a table or column that captures it, or describe what it means in terms I can look up?`,
        source: "detector" as const
      })
    }
    return out
  }
}

/**
 * Is the phrase (or any of its constituent tokens) a known catalog
 * identifier — table name, column name, schema, or token thereof?
 *
 * We check the phrase whole first (e.g. "Stock Reconciliation" matches
 * a table named StockReconciliation via the tokenized name index) and
 * then fall back to per-token matches so a partial known phrase
 * (e.g. "Revenue Forecast" where "Revenue" is a known view) is not
 * flagged.
 */
function isKnownInCatalog(lcPhrase: string, catalog: CatalogGraph): boolean {
  // tokenize the phrase by whitespace; nameIndex tokens are lowercase
  // alphanumeric runs split on word boundaries already.
  const tokens = lcPhrase.split(/\s+/).filter((t) => t.length > 0)
  for (const t of tokens) {
    if (catalog.nameIndex.has(t)) return true
    if (catalog.columnIndex.has(t)) return true
  }
  // also accept the joined-no-space form ("stockreconciliation") because
  // nameIndex tokenization splits camelCase but the user may have written
  // the words separately.
  const joined = tokens.join("")
  if (joined.length > 0 && catalog.nameIndex.has(joined)) return true
  return false
}

/**
 * Does the tenant config declare this phrase (or any token) as a known
 * domain term, sync keyword, or schema routing keyword? Tenants can
 * register tenant-specific vocabulary here to suppress false positives
 * without rebuilding the catalog.
 */
function isKnownToTenant(lcPhrase: string, tenant: TenantConfig): boolean {
  const tokens = lcPhrase.split(/\s+/).filter((t) => t.length > 0)
  const known = new Set<string>()
  for (const w of tenant.routingKeywords.domain) known.add(w.toLowerCase())
  for (const w of tenant.routingKeywords.schemas) known.add(w.toLowerCase())
  for (const w of tenant.routingKeywords.sync ?? []) known.add(w.toLowerCase())
  if (known.has(lcPhrase)) return true
  for (const t of tokens) if (known.has(t)) return true
  return false
}
