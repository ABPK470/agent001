// schema-match detector — "this noun matches multiple catalog things".
//
// Fires (block-severity) when a non-stopword token in the user goal
// matches more than one distinct catalog table or view via the
// catalog's nameIndex. The agent should ask the user to disambiguate
// before running any data tool.
//
// Pure function of (goal, catalog, messages). No I/O, no LLM.

import { MessageRole } from "../../../../domain/enums/message.js"
import type { ClarifyContext, Detector } from "../types.js"
import { makeFindingId } from "../types.js"
import {
  anchorConsumedTokens,
  isPrimaryTableNameToken,
  resolveGoalDataAnchors,
  shouldSuppressAmbiguousTokenGivenAnchors
} from "../goal-data-anchors.js"
import {
  isCanonicallyGroundedEntity,
  rankEntityTableCandidates,
  resolveCanonicalEntityTable
} from "../entity-canonical.js"
import { mergeReservedTokens } from "./reserved-tokens.js"
import { goalTokens } from "./stopwords.js"

/**
 * Bumped when the detection rule materially changes. Surface bumps in
 * trace events so a re-run with an updated detector can be told from
 * a fresh hit.
 *
 * 1.1.0: coreference guard — skip when the goal is a pronoun/anaphora
 * reference and the conversation already contains an assistant turn
 * (the referent IS that turn, not a catalog ambiguity). Min token
 * length raised to 4 so 2-3 char accidental matches stop firing.
 *
 * 1.2.0: qualified-name guard — when the goal contains a `schema.object`
 * literal that resolves against the catalog (directly or via the
 * deployment's mirrorSchema), BOTH halves are treated as disambiguated
 * by the user themselves. Without this, a goal like "use publish.Revenue"
 * fires two blocking findings ("publish" → 1341 candidates, "revenue" →
 * 562) even though the user typed the fully-qualified name. The bug
 * surfaced in production on 22 May 2026.
 *
 * 1.3.0: object-name scope only — schema-match now ignores collisions that
 * arise solely from COLUMN tokens in `nameIndex`. Broad request nouns like
 * "product" / "revenue" often appear across many columns, and blocking on
 * those prevents the agent from using search_catalog or schema exploration to
 * resolve the path itself. The detector still blocks on ambiguous schema/table
 * names, and skips metric-position tokens like "by revenue".
 *
 * 1.6.0: catalog-ranked candidates — dim/publish tables surface before archive;
 * canonical entity resolution suppresses domain nouns with a known dim table.
 */
const VERSION = "1.6.0"

/**
 * Tokens already disambiguated by a qualified reference the user wrote
 * themselves. Both halves of every resolvable `schema.object` reference
 * in the goal are added — the schema half because the user picked it,
 * the object half because the catalog confirms it pairs with that schema.
 */
function disambiguatedTokens(goal: string, catalog: CatalogGraph): Set<string> {
  const anchors = resolveGoalDataAnchors(goal, catalog)
  return anchorConsumedTokens(anchors)
}

/**
 * Hard upper bound on candidates listed in the finding. Past this many
 * the candidate list ceases to be useful for the LLM (and starts
 * costing prompt budget). The reasoning text still cites the total.
 */
const MAX_CANDIDATES = 6

/** Min token length this detector will consider. Tokens shorter than
 *  this almost always match catalog identifiers by coincidence
 *  (e.g. "fx" matching every Fx-prefixed archive table). Defined
 *  detector-locally so we don't tighten the shared `goalTokens` floor
 *  for other detectors that legitimately use short tokens. */
const MIN_TOKEN_LEN = 4

/**
 * True when the goal text looks like a co-reference / anaphora — i.e.
 * the user is referring to something earlier in the conversation
 * rather than naming a new noun. Tight regex (not full NLP) to keep
 * the detector pure & cheap; covers the patterns that actually appear
 * in chat ("plot it", "filter that", "for this data", "the result").
 */
function looksCoreferential(goal: string): boolean {
  return /\b(it|this|that|these|those|the\s+(data|result|results|report|chart|output|table|rows|answer|response))\b/i.test(
    goal
  )
}

function hasRecentAssistantTurn(messages: readonly ClarifyContext["messages"][number][]): boolean {
  for (const m of messages) {
    if (m.role === MessageRole.Assistant && typeof m.content === "string" && m.content.trim().length > 0) {
      return true
    }
  }
  return false
}

/**
 * True when `token` is how a user would name this table — the object's own
 * name or its leading camelCase word (Revenue, RevenueRaw) — not an
 * incidental token buried inside a compound name (sync inside BookSync…).
 */
function objectNameMatches(catalog: CatalogGraph, token: string): Set<string> {
  const out = new Set<string>()
  for (const [key, table] of catalog.tables) {
    if (table.schema.toLowerCase() === token) {
      out.add(key)
      continue
    }
    if (isPrimaryTableNameToken(table.name, token)) out.add(key)
  }
  return out
}

function isMetricContext(goal: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\bby\\s+${escaped}\\b`, "i").test(goal)
}

function isTemporalContext(goal: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\b${escaped}\\s+(year|month|quarter|week)\\b`, "i").test(goal)
}

export const schemaMatchDetector: Detector = {
  id: "schema-match",
  version: VERSION,

  detect(ctx) {
    if (!ctx.catalog) return []
    // Co-reference guard: when the goal is pronoun-shaped AND we already
    // have a prior assistant turn in scope, the referent is that turn's
    // answer — NOT a multi-match catalog noun. Without this guard, the
    // detector misfires on every follow-up like "plot it" / "filter that"
    // by latching onto incidentally-shared tokens between the goal and
    // archive.* table names. Fed from system-messages.ts which now
    // passes the prior-turns synthetic transcript via ctx.messages.
    if (looksCoreferential(ctx.goal) && hasRecentAssistantTurn(ctx.messages)) return []
    const reserved = mergeReservedTokens(ctx)
    // Qualified-name guard: any `schema.object` the user already typed
    // and that resolves against the live catalog (with mirrorSchema
    // fallback) consumes BOTH halves — the user disambiguated themselves.
    const consumed = disambiguatedTokens(ctx.goal, ctx.catalog)
    const anchors = resolveGoalDataAnchors(ctx.goal, ctx.catalog)
    const domainKeywords = ctx.tenant.domainKeywords
    const out = []
    const seenTokens = new Set<string>()
    for (const token of goalTokens(ctx.goal)) {
      if (token.length < MIN_TOKEN_LEN) continue
      if (reserved?.has(token)) continue
      if (consumed.has(token)) continue
      if (seenTokens.has(token)) continue
      if (isMetricContext(ctx.goal, token)) continue
      if (isTemporalContext(ctx.goal, token)) continue
      seenTokens.add(token)
      if (
        shouldSuppressAmbiguousTokenGivenAnchors(token, ctx.goal, anchors, domainKeywords)
      ) {
        continue
      }
      if (isCanonicallyGroundedEntity(token, ctx.catalog, ctx.tenant, ctx.learnedTermMappings)) continue
      const matches = objectNameMatches(ctx.catalog, token)
      if (matches.size < 2) continue

      const canonical = resolveCanonicalEntityTable(token, ctx.catalog, ctx.tenant, ctx.learnedTermMappings)
      if (canonical) {
        const canonicalLc = canonical.toLowerCase()
        const nonCanonical = [...matches].filter((k) => {
          const t = ctx.catalog!.getTable(k)
          return (t?.qualifiedName.toLowerCase() ?? k.toLowerCase()) !== canonicalLc
        })
        if (nonCanonical.length === 0) continue
      }

      const candidates = rankEntityTableCandidates(token, matches, ctx.catalog, MAX_CANDIDATES, {
        goal: ctx.goal
      })
      const totalCount = matches.size
      const canonicalHint = canonical ? ` Prefer ${canonical} unless you need a subset.` : ""
      out.push({
        id: makeFindingId("schema-match", token),
        kind: "schema-match" as const,
        severity: "block" as const,
        subject: token,
        reasoning: `"${token}" matches ${totalCount} catalog objects — the agent cannot pick one without input.${canonicalHint}`,
        candidates,
        uiOptions: candidates,
        suggestedQuestion: canonical
          ? `When you say "${token}", did you mean ${canonical} or a different table?`
          : `When you say "${token}", which did you mean?`,
        source: "detector" as const
      })
    }
    return out
  }
}
