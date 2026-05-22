// schema-match detector — "this noun matches multiple catalog things".
//
// Fires (block-severity) when a non-stopword token in the user goal
// matches more than one distinct catalog table or view via the
// catalog's nameIndex. The agent should ask the user to disambiguate
// before running any data tool.
//
// Pure function of (goal, catalog). No I/O, no LLM.

import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"
import { goalTokens } from "./stopwords.js"

/**
 * Bumped when the detection rule materially changes. Surface bumps in
 * trace events so a re-run with an updated detector can be told from
 * a fresh hit.
 */
const VERSION = "1.0.0"

/**
 * Hard upper bound on candidates listed in the finding. Past this many
 * the candidate list ceases to be useful for the LLM (and starts
 * costing prompt budget). The reasoning text still cites the total.
 */
const MAX_CANDIDATES = 6

export const schemaMatchDetector: Detector = {
  id: "schema-match",
  version: VERSION,

  detect(ctx) {
    if (!ctx.catalog) return []
    const out = []
    const seenTokens = new Set<string>()
    for (const token of goalTokens(ctx.goal)) {
      if (seenTokens.has(token)) continue
      seenTokens.add(token)
      const matches = ctx.catalog.nameIndex.get(token)
      if (!matches || matches.size < 2) continue
      const candidates = [...matches].sort().slice(0, MAX_CANDIDATES)
      const totalCount = matches.size
      const more = totalCount > candidates.length ? ` (and ${totalCount - candidates.length} more)` : ""
      out.push({
        id: makeFindingId("schema-match", token),
        kind: "schema-match" as const,
        severity: "block" as const,
        subject: token,
        reasoning: `"${token}" matches ${totalCount} catalog objects — the agent cannot pick one without input.`,
        candidates,
        suggestedQuestion: `When you say "${token}", which of these did you mean?\n${candidates.map((c) => `  • ${c}`).join("\n")}${more}`,
        source: "detector" as const,
      })
    }
    return out
  },
}
