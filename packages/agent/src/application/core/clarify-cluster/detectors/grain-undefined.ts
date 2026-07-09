// grain-undefined detector — "this period word matches multiple grain columns".
//
// Fires (warn-severity) when the goal mentions a period word ("monthly",
// "by month", "daily", etc.) AND the catalog has more than one column
// whose name contains that period root. Common case: dim tables expose
// both `pkMonth` (reporting month) and `pkAccountingMonth` (accounting
// month) — picking the wrong one silently mis-buckets data.
//
// Pure function of (goal, catalog). No I/O, no LLM.

import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"

const VERSION = "1.0.0"

/**
 * Period roots — the canonical singular noun form the detector searches
 * for in column names. Each entry pairs the user-facing phrasing
 * regexes (matched in the goal) with the column-name substring to scan.
 *
 * Conservative coverage; intentionally omits "minute", "second" because
 * those almost never appear as analytic grains.
 */
const PERIOD_GROUPS: readonly { match: RegExp; root: string; label: string }[] = [
  { match: /\b(daily|by\s+day|per\s+day)\b/i, root: "day", label: "day" },
  { match: /\b(weekly|by\s+week|per\s+week)\b/i, root: "week", label: "week" },
  { match: /\b(monthly|by\s+month|per\s+month)\b/i, root: "month", label: "month" },
  { match: /\b(quarterly|by\s+quarter|per\s+quarter)\b/i, root: "quarter", label: "quarter" },
  { match: /\b(yearly|annually|by\s+year|per\s+year)\b/i, root: "year", label: "year" }
]

const MAX_CANDIDATES = 6

export const grainUndefinedDetector: Detector = {
  id: "grain-undefined",
  version: VERSION,

  detect(ctx) {
    if (!ctx.catalog) return []
    const out = []
    for (const group of PERIOD_GROUPS) {
      if (!group.match.test(ctx.goal)) continue
      // collect all column names whose lowercase contains the root.
      const matchingCols = new Set<string>()
      for (const colName of ctx.catalog.columnIndex.keys()) {
        if (colName.includes(group.root)) matchingCols.add(colName)
      }
      if (matchingCols.size < 2) continue
      const candidates = [...matchingCols].sort().slice(0, MAX_CANDIDATES)
      out.push({
        id: makeFindingId("grain-undefined", group.label),
        kind: "grain-undefined" as const,
        severity: "warn" as const,
        subject: group.label,
        reasoning: `"${group.label}" grain is ambiguous: ${matchingCols.size} columns match that period in the catalog.`,
        candidates,
        uiOptions: candidates,
        suggestedQuestion: `For "${group.label}" grouping, which column should I use?`,
        source: "detector" as const
      })
    }
    return out
  }
}
