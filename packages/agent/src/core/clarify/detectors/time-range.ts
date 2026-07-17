// time-range detector — "vague time word with no anchor date".
//
// Fires (warn-severity) when the goal uses imprecise time language
// ("recent", "lately", "last year", "current") AND contains no explicit
// year (`20\d\d`) or ISO-style date. "Last year" is ambiguous between
// calendar year, fiscal year, and rolling-365; the agent should confirm.
//
// Pure function of (goal). No catalog, no I/O.

import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"

const VERSION = "1.0.0"

/**
 * Vague time phrases. Matched case-insensitive as whole-word/phrase.
 * The phrase that matched becomes the finding's subject.
 */
const VAGUE_TIME =
  /\b(recent(?:ly)?|lately|latest|current(?:ly)?|nowadays|these\s+days|this\s+period|last\s+(?:year|quarter|month|week|day)|past\s+(?:year|quarter|month|week|few\s+(?:months|weeks|days))|previous\s+(?:year|quarter|month|week|day))\b/i

/** Any 4-digit year between 1900 and 2099 counts as an anchor. */
const YEAR_ANCHOR = /\b(19|20)\d{2}\b/
/** ISO date `YYYY-MM-DD` or month-day forms also count as anchors. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/
/** Explicit month-name + year ("January 2024", "Jan 2024"). */
const MONTH_YEAR =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b\s*\d{4}\b/i

export const timeRangeDetector: Detector = {
  id: "time-range",
  version: VERSION,

  detect(ctx) {
    const m = ctx.goal.match(VAGUE_TIME)
    if (!m) return []
    // If the goal also contains an explicit year or date, assume the
    // vague word is bracketed and not actually ambiguous.
    if (YEAR_ANCHOR.test(ctx.goal)) return []
    if (ISO_DATE.test(ctx.goal)) return []
    if (MONTH_YEAR.test(ctx.goal)) return []
    const phrase = m[0]
    return [
      {
        id: makeFindingId("time-range", phrase),
        kind: "time-range" as const,
        severity: "warn" as const,
        subject: phrase,
        reasoning: `"${phrase}" is an unanchored time phrase — calendar year, fiscal year, rolling window, or year-to-date all produce different results.`,
        suggestedQuestion: `What exact date range does "${phrase}" mean here? (e.g. 2025-01-01 to 2025-12-31, last 365 days, calendar Q1 2025, …)`,
        source: "detector" as const
      }
    ]
  }
}
