// empty-result detector — "last data tool came back empty".
//
// Fires (warn-severity) when ctx.lastToolResultText indicates zero rows
// were returned. The detector is intentionally textual — orchestrator
// shapes the lastToolResultText to whatever the tool's summary looked
// like, and the detector keys on widely-shared empty markers.
//
// Pure function of (lastToolResultText). No catalog, no I/O.

import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"

const VERSION = "1.0.0"

/**
 * Phrases that authoritatively mean "the tool returned nothing useful".
 * Combine: explicit zero counts, common natural-language phrasings,
 * and the canonical empty-array JSON literal.
 */
const EMPTY_PATTERNS: readonly RegExp[] = [
  /\b0\s+rows?\b/i,
  /\bno\s+(rows?|results?|matches?|records?|data)\b/i,
  /\breturned\s+(nothing|empty)\b/i,
  /\bempty\s+result\s*set\b/i,
  /^\s*\[\s*\]\s*$/, // exact empty JSON array as the whole result
]

export const emptyResultDetector: Detector = {
  id: "empty-result",
  version: VERSION,

  detect(ctx) {
    const text = ctx.lastToolResultText
    if (!text) return []
    if (!EMPTY_PATTERNS.some((p) => p.test(text))) return []
    // single, stable finding id per round — there is only ever one
    // "last tool" being empty.
    return [{
      id: makeFindingId("empty-result", "last-tool-call"),
      kind: "empty-result" as const,
      severity: "warn" as const,
      subject: "last tool call",
      reasoning: "The most recent data tool call returned no rows; the agent should not silently produce an empty answer.",
      suggestedQuestion: `The previous query came back empty. Could you confirm the scope — different period, different filter, a different table, or is empty actually the expected answer?`,
      source: "detector" as const,
    }]
  },
}
