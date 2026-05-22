// metric-undefined detector — "ranking language with no metric named".
//
// Fires (warn-severity) when the user goal contains ranking/aggregation
// language ("top", "biggest", "best", etc.) but names no measure column.
// Warn — not block — because the agent may reasonably pick the obvious
// metric for a clearly-scoped query ("top 10 customers by revenue" when
// there is exactly one revenue column). The agent is expected to name
// its assumption in the answer.
//
// Pure function of (goal, catalog). No I/O, no LLM.

import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"
import { goalTokens } from "./stopwords.js"

const VERSION = "1.0.0"

/**
 * Ranking / aggregation language. Each entry is matched as a whole word
 * (case-insensitive) anywhere in the goal text.
 */
const RANKING_PATTERN = /\b(top|bottom|biggest|smallest|highest|lowest|most|least|best|worst|largest|leading|trailing)\b/i

/**
 * Numeric MSSQL data types that count as a metric. Listed exhaustively
 * so the detector does not need to introspect a tenant-specific type
 * registry. Matches are case-insensitive substring checks against
 * CatalogColumn.dataType.
 */
const METRIC_TYPES: readonly string[] = [
  "decimal", "numeric", "money", "smallmoney",
  "float", "real",
  "int", "bigint", "smallint", "tinyint",
]

export const metricUndefinedDetector: Detector = {
  id: "metric-undefined",
  version: VERSION,

  detect(ctx) {
    if (!ctx.catalog) return []
    const m = ctx.goal.match(RANKING_PATTERN)
    if (!m) return []
    const rankWord = m[0].toLowerCase()
    // If any token of the goal is the name of a numeric column anywhere
    // in the catalog, treat the metric as named and stay silent.
    const tokens = new Set(goalTokens(ctx.goal))
    for (const token of tokens) {
      const tables = ctx.catalog.columnIndex.get(token)
      if (!tables || tables.size === 0) continue
      // verify at least one such column is numeric
      for (const tk of tables) {
        const t = ctx.catalog.tables.get(tk)
        if (!t) continue
        const col = t.columns.find((c) => c.name.toLowerCase() === token)
        if (!col) continue
        if (METRIC_TYPES.some((m) => col.dataType.toLowerCase().includes(m))) {
          return [] // metric is named — nothing to clarify
        }
      }
    }
    return [{
      id: makeFindingId("metric-undefined", rankWord),
      kind: "metric-undefined" as const,
      severity: "warn" as const,
      subject: rankWord,
      reasoning: `"${rankWord}" implies a ranking but the goal names no measure column to rank by.`,
      suggestedQuestion: `You asked for "${rankWord}" — what should I rank by? (Name a numeric column or measure.)`,
      source: "detector" as const,
    }]
  },
}
