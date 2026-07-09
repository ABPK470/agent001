// canonical-ambiguity detector — "two candidate tables are too close to call".
//
// Fires WARN-severity when a goal contains a metric-shaped noun
// (`domainKeywords` from tenant config) AND the live
// search_catalog pass returns a top-1 candidate whose score is within
// 15% of the top-2 candidate. The intent is to flag situations like
// the 22-May-2026 incident where `publish.RevenueESGRules` outscored
// `publish.Revenue` by a hair — both were plausible without further
// context, and the agent picked the smaller subset table by accident.
//
// Suppressed when:
//   - the goal already contains a `schema.object` literal that resolves
//     against the catalog (the user disambiguated themselves);
//   - the goal is co-referential ("plot it", "filter that") and a
//     prior assistant turn exists (the referent is that turn);
//   - the catalog has fewer than 2 hits for the goal (no contest).
//
// Pure function of (goal, catalog, tenant). No I/O, no LLM.

import { MessageRole } from "../../../../domain/enums/message.js"
import type { ClarifyContext, Detector } from "../types.js"
import { makeFindingId } from "../types.js"
import { resolveGoalDataAnchors } from "../goal-data-anchors.js"

/**
 * 1.0.0: initial release. Top-1 within 15% of top-2 → WARN; goal must
 * contain ≥1 tenant-domain keyword to fire (otherwise the score-gap
 * heuristic is noisy on schema-exploration questions).
 */
const VERSION = "1.0.0"

/**
 * Score-gap threshold. `top1.score >= top2.score * (1 - SCORE_GAP)`
 * fires the warning. 15% matches the empirical Revenue/RevenueESGRules
 * incident where the gap was ~7%; 15% gives modest headroom without
 * triggering on clear winners (parent UNION views typically lead by
 * 30-80% under the Phase 1 structural signals).
 */
const SCORE_GAP = 0.15

/** Top-K candidates to consider. 2 is enough for top-1 vs top-2 gap. */
const CATALOG_TOP_K = 5

/** Same co-reference heuristic as schema-match — keeps behaviours aligned. */
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

/** True when goal contains at least one tenant-configured domain
 *  keyword (revenue, exposure, pnl, …). Tokenises on word boundaries
 *  so substrings inside other words don't count. */
function goalHasDomainKeyword(goal: string, keywords: readonly string[]): string | null {
  if (keywords.length === 0) return null
  const lower = goal.toLowerCase()
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim()
    if (k.length < 3) continue
    const re = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
    if (re.test(lower)) return k
  }
  return null
}

export const canonicalAmbiguityDetector: Detector = {
  id: "canonical-ambiguity",
  version: VERSION,

  detect(ctx) {
    if (!ctx.catalog) return []
    // Co-reference: defer to prior turn.
    if (looksCoreferential(ctx.goal) && hasRecentAssistantTurn(ctx.messages)) return []
    // User already named a data source → no ambiguity to flag.
    if (resolveGoalDataAnchors(ctx.goal, ctx.catalog).length > 0) return []
    const matchedKeyword = goalHasDomainKeyword(ctx.goal, ctx.tenant.domainKeywords)
    if (!matchedKeyword) return []

    const hits = ctx.catalog.search(ctx.goal, CATALOG_TOP_K)
    if (hits.length < 2) return []
    const [top1, top2] = hits
    if (!top1 || !top2) return []
    if (top1.score <= 0 || top2.score <= 0) return []

    const gap = (top1.score - top2.score) / top1.score
    if (gap >= SCORE_GAP) return []

    const candidates = hits.slice(0, 3).map((h) => {
      const rows = h.table.rowCount ?? 0
      const kind = h.table.type === "VIEW" ? "VIEW" : "TABLE"
      const rowFmt =
        rows >= 1_000_000
          ? `${(rows / 1_000_000).toFixed(1)}M rows`
          : rows >= 1_000
            ? `${(rows / 1_000).toFixed(0)}k rows`
            : `${rows} rows`
      return `${h.table.qualifiedName} (${kind}, score ${Math.round(h.score)}, ${rowFmt})`
    })

    return [
      {
        id: makeFindingId("canonical-ambiguity", matchedKeyword),
        kind: "canonical-ambiguity" as const,
        severity: "warn" as const,
        subject: matchedKeyword,
        reasoning:
          `Top two catalog matches for "${matchedKeyword}" are within ` +
          `${Math.round(gap * 100)}% on rank score — picking the wrong one ` +
          `can silently swap a canonical metric for a narrower subset.`,
        candidates,
        suggestedQuestion:
          `For "${matchedKeyword}", which of these tables should I use?\n` +
          candidates.map((c) => `  • ${c}`).join("\n"),
        source: "detector" as const
      }
    ]
  }
}
