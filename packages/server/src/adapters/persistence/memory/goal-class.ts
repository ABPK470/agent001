/**
 * Gap 5 — goal-class extraction for procedural memory recall.
 *
 * The `procedural_memories.trigger` column is the raw user goal text
 * ("list top 3 products based on revenue for April 2025"). FTS5 over
 * that field works fine for near-duplicate goals but does NOT transfer
 * across analogous-but-differently-worded goals ("top 50 clients by
 * revenue"). Both goals share the same abstract shape — rank entities
 * by an aggregate metric, possibly filtered by time — yet share almost
 * no surface tokens, so the second never recalls the first's recipe.
 *
 * Fix: derive a small set of CamelCase class tags from the goal text
 * (lossy, deterministic, regex-only — no LLM call), append them to the
 * stored trigger so FTS indexes them, and OR them into the search query
 * so a new goal's class tags can match an old recipe's class tags even
 * when no surface tokens overlap.
 *
 * Tags are single tokens (no spaces / punctuation) so the SQLite FTS5
 * default tokenizer treats each as one term. Set is intentionally tiny —
 * extending it should be driven by recall-failure evidence, not
 * speculation.
 */

const CLASSIFIERS: Array<{ tag: string; re: RegExp }> = [
  // Ranking: "top 50", "bottom 10", "highest", "lowest", "biggest", "smallest"
  {
    tag: "rankbymetric",
    re: /\b(top|bottom)\s+\d+\b|\b(highest|lowest|biggest|smallest|largest|leading)\b/i
  },
  // Aggregation: "sum", "total", "average", "avg", "count", "how many", "how much"
  { tag: "aggregateby", re: /\b(sum|total|average|avg|mean|median|count|how\s+(?:many|much))\b/i },
  // Comparison / change-over-time: "vs", "compared", "difference between", "change between"
  {
    tag: "comparison",
    re: /\b(vs\.?|compared|comparison|difference\s+between|change\s+(?:between|in|over)|growth|trend|trends|year\s*over\s*year|yoy|mom|month\s*over\s*month)\b/i
  },
  // Time-filtered: explicit year, quarter, month, MTD/YTD/QTD, "for April 2025", "in 2024"
  {
    tag: "timefiltered",
    re: /\b(20\d{2}|q[1-4]\b|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ytd|mtd|qtd|wtd|fiscal\s+year|last\s+(?:month|year|quarter|week))\b/i
  },
  // Pivot / group-by dimension: "by client", "per product", "by month", "per region"
  {
    tag: "pivotbydim",
    re: /\b(?:by|per)\s+(client|customer|product|month|year|quarter|day|week|region|branch|account|sector|industry|country|currency)s?\b/i
  },
  // Existence / lookup / explanation: "what is", "what tables", "show me", "list", "find", "look up"
  { tag: "lookup", re: /\b(what\s+(?:is|are|tables?)|show\s+me|list|find|look\s*up|describe|explain)\b/i },
  // Export / file: "export", "save to", "write to file", "download"
  {
    tag: "exportfile",
    re: /\b(export|download|save\s+to|write\s+to\s+file|to\s+(?:csv|xlsx|parquet|json))\b/i
  }
]

/**
 * Returns CamelCase class tags for the goal, in stable order, deduped.
 * Empty when no classifier matches.
 */
export function extractGoalClasses(goal: string): string[] {
  if (!goal) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const c of CLASSIFIERS) {
    if (seen.has(c.tag)) continue
    if (c.re.test(goal)) {
      out.push(c.tag)
      seen.add(c.tag)
    }
  }
  return out
}

/**
 * Render the class-tag tail appended to the stored trigger. Empty
 * string when no classes match. Format kept stable so the UI / log
 * inspectors can recognise and strip the tail if they want to display
 * the original goal verbatim.
 */
export function renderClassTail(classes: readonly string[]): string {
  if (classes.length === 0) return ""
  return `\n[goalclasses ${classes.join(" ")}]`
}
