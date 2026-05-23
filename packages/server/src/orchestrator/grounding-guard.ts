/**
 * grounding-guard.ts — flag-gated output guard that detects when a final
 * answer contains chart/table/dashboard values whose numbers don't appear
 * in any tool result from THIS turn.
 *
 * Phase E (no-amnesia, behind FEATURE_GROUNDING_GUARD env flag) — belt-and-
 * suspenders on top of the doctrine + <prior_results> grounding. Even when
 * the model violates the "no paraphrase-as-evidence" rule, this guard
 * prepends a banner so the user sees the values weren't grounded.
 *
 * Triggers ONLY when:
 *   - the env flag is on,
 *   - the goal contains an anaphoric trigger (it / that / those / prior / previous),
 *   - no query_mssql / export_query_to_file / recall_prior_result ran this turn,
 *   - the answer contains numeric chart / table values that aren't present
 *     in any prior_results payload either.
 *
 * Returns the (possibly banner-prefixed) answer. Never modifies the answer
 * body — only prepends a warning line for the user.
 */

import type { DbToolResult } from "../db/tool-results.js"

const ENV_FLAG = "FEATURE_GROUNDING_GUARD"

const ANAPHORIC_TRIGGERS = /\b(?:it|that|those|these|previous|prior|earlier|last\s+(?:result|run|query|turn|chart|table))\b/i

/** Tool names that count as fetching fresh / explicitly-recalled evidence. */
const FRESH_EVIDENCE_TOOLS = new Set<string>([
  "query_mssql",
  "export_query_to_file",
  "recall_prior_result",
])

/** Inline chart/dashboard fence languages we know about. */
const CHART_FENCE_RE = /```(?:bar|line|pie|kpi|dashboard|area|scatter|stack)\b[\s\S]*?```/gi

/** Numeric token: integer or decimal, optional commas, optional %/$/£ etc. */
const NUMBER_TOKEN_RE = /\d[\d,]*(?:\.\d+)?/g

/** Smallest numeric value worth checking. Drops 0/1/2 noise. */
const MIN_NUMBER_LENGTH = 3

export interface GroundingGuardInput {
  goal: string
  answer: string
  /** Names of tools that fired in THIS run. */
  toolNamesUsedThisRun: ReadonlySet<string>
  /** Prior-results payloads visible to this turn (already loaded by the orchestrator). */
  priorResults: readonly DbToolResult[]
}

/** Public banner string (exported for testing). */
export const GROUNDING_GUARD_BANNER =
  "⚠️ Values not backed by a tool call this turn — treat as illustrative.\n\n"

/**
 * Run the guard. Returns the answer unchanged when the guard is disabled or
 * the answer is grounded. Prepends a banner when the heuristic detects
 * ungrounded numeric chart/table values.
 */
export function applyGroundingGuard(input: GroundingGuardInput): string {
  if (process.env[ENV_FLAG] !== "1") return input.answer
  if (!ANAPHORIC_TRIGGERS.test(input.goal)) return input.answer

  // If the model fetched / recalled this turn, trust it.
  for (const t of input.toolNamesUsedThisRun) {
    if (FRESH_EVIDENCE_TOOLS.has(t)) return input.answer
  }

  // Extract chart bodies — those are the highest-risk locations for invented
  // numbers (the failing trace was a confabulated chart from prose).
  const chartMatches = input.answer.match(CHART_FENCE_RE) ?? []
  if (chartMatches.length === 0) return input.answer

  const chartNumbers = collectNumbers(chartMatches.join("\n"))
  if (chartNumbers.size === 0) return input.answer

  // Build the haystack: every prior_results payload's text. If a chart number
  // doesn't appear here, the model couldn't have grounded it.
  const haystack = input.priorResults.map((r) => extractText(r.result_json)).join("\n")

  // If any chart number is missing from the haystack, we're ungrounded.
  for (const n of chartNumbers) {
    if (!haystack.includes(n)) {
      return GROUNDING_GUARD_BANNER + input.answer
    }
  }
  return input.answer
}

function collectNumbers(text: string): Set<string> {
  const out = new Set<string>()
  const matches = text.match(NUMBER_TOKEN_RE) ?? []
  for (const m of matches) {
    if (m.length >= MIN_NUMBER_LENGTH) out.add(m)
  }
  return out
}

function extractText(json: string): string {
  try {
    const parsed = JSON.parse(json) as { text?: unknown }
    if (typeof parsed.text === "string") return parsed.text
  } catch { /* fall through */ }
  return json
}
