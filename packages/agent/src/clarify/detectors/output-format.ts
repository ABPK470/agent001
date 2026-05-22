// output-format detector — "summarise / overview / explain without format hint".
//
// Fires (warn-severity) when the goal asks for a free-form summary
// ("summarise", "give me an overview", "what's going on with X",
// "explain", "tell me about") and contains no explicit output-format
// hint (table, chart, graph, list, csv, json, …). Lets the agent
// produce something useful without guessing the desired presentation.
//
// Pure function of (goal). No catalog, no I/O.

import type { Detector } from "../types.js"
import { makeFindingId } from "../types.js"

const VERSION = "1.0.0"

const SUMMARISE_PATTERN = /\b(summari[sz]e|summary|overview|recap|brief(?:ing)?|explain|describe|tell\s+me\s+about|what'?s\s+going\s+on)\b/i

const FORMAT_HINT_PATTERN = /\b(table|chart|graph|bar|line|pie|scatter|histogram|csv|json|list|paragraph|narrative|markdown|spreadsheet|excel|dashboard|export)\b/i

export const outputFormatDetector: Detector = {
  id: "output-format",
  version: VERSION,

  detect(ctx) {
    const m = ctx.goal.match(SUMMARISE_PATTERN)
    if (!m) return []
    if (FORMAT_HINT_PATTERN.test(ctx.goal)) return []
    const subject = m[0].toLowerCase()
    return [{
      id: makeFindingId("output-format", subject),
      kind: "output-format" as const,
      severity: "warn" as const,
      subject,
      reasoning: `Goal asks to "${subject}" but specifies no output format.`,
      candidates: ["short narrative", "data table", "chart (bar/line/pie)", "bullet list"],
      suggestedQuestion: `How would you like the "${subject}" delivered — a short narrative, a data table, a chart, or a bullet list?`,
      source: "detector" as const,
    }]
  },
}
