/**
 * prior-results-block.ts — load and render the `<prior_results>` system
 * anchor that gives the agent loop access to actual structured tool
 * payloads from earlier turns in the same session.
 *
 * Why this exists (no-amnesia, Phase 9):
 * `<prior_turns>` only carries the model's own prose paraphrase, which the
 * model then treats as evidence and confabulates exact numbers from. This
 * block injects the actual stored tool result (sample rows, evidence tags)
 * so a follow-up like "plot it" can ground on real data.
 *
 * Each rendered entry carries an `[evidence: run=<runId>, tool_call=<tcId>]`
 * tag. The agent doctrine (mia-data-persona.md) instructs the model to
 * either ground on those tags, call `recall_prior_result(...)` for the
 * full payload, or re-run the tool fresh. Paraphrase-as-evidence is a
 * doctrine violation.
 *
 * Budget discipline:
 *   - Cap to the most recent MAX_RESULTS results across the last few runs.
 *   - Per-result text is clipped to PER_RESULT_CHARS — enough rows to
 *     ground on, not a full mirror. Full payload is retrievable via the
 *     recall tool.
 */

import type { DbToolResult } from "../../../adapters/persistence/tool-results.js"
import {
  extractToolResultText,
  isRecallableToolResult,
  loadRecentToolResults
} from "../../../adapters/persistence/tool-results.js"

/** Tools whose results we surface in <prior_results>. Mirrors the writer. */
const SURFACED_TOOLS = ["query_mssql", "export_query_to_file"] as const

/** Max number of prior tool results rendered into the anchor. */
const MAX_RESULTS = 6

/** Per-result clipped text length. Keeps the anchor inside the token budget. */
const PER_RESULT_CHARS = 1500

export interface LoadPriorResultsOptions {
  readonly sessionId: string
  /** Exclude tool results from the current run. */
  readonly excludeRunId?: string | null
}

/**
 * Load recent structured tool results for the session, newest first.
 * Returns `[]` when no session is set (CLI / first call).
 */
export function loadPriorResults(opts: LoadPriorResultsOptions): DbToolResult[] {
  if (!opts.sessionId) return []
  const rows = loadRecentToolResults({
    sessionId: opts.sessionId,
    limit: MAX_RESULTS * 4, // pull a window, then filter
    toolNames: SURFACED_TOOLS
  })
  const excludeRunId = opts.excludeRunId ?? null
  return rows.filter((r) => r.run_id !== excludeRunId && isRecallableToolResult(r)).slice(0, MAX_RESULTS)
}

/**
 * Render the `<prior_results>` system anchor block. Returns empty string
 * when there are no results to surface — caller can use the empty-string
 * sentinel to decide whether to inject the anchor at all.
 */
export function renderPriorResultsBlock(results: readonly DbToolResult[]): string {
  if (results.length === 0) return ""
  const lines: string[] = [
    "<prior_results>",
    "Structured tool-call payloads from earlier turns in THIS session. These",
    "are the ACTUAL outputs the warehouse returned — not the assistant's prose",
    "paraphrase. When you reference earlier data ('it', 'that result', 'the",
    "chart from before'), you MUST ground on these payloads via the evidence",
    "tag, OR call recall_prior_result() for the full version, OR re-run the",
    "tool. Quoting numbers from <prior_turns> prose is a doctrine violation.",
    ""
  ]
  results.forEach((r, i) => {
    const label = `Result -${i + 1}`
    const truncMarker = r.truncated ? " [truncated]" : ""
    const rowCountStr = r.row_count != null ? ` rows=${r.row_count}` : ""
    lines.push(
      `${label} [evidence: run=${r.run_id}, tool_call=${r.tool_call_id}]${truncMarker}${rowCountStr}`
    )
    lines.push(`  Tool: ${r.tool_name}`)
    if (r.goal_excerpt) lines.push(`  Goal: ${oneLine(r.goal_excerpt)}`)
    const args = oneLine(r.args_json)
    if (args && args !== "{}") lines.push(`  Args: ${args.slice(0, 240)}`)
    const text = extractToolResultText(r.result_json)
    const clipped =
      text.length > PER_RESULT_CHARS
        ? text.slice(0, PER_RESULT_CHARS) + "\n    …[clipped — call recall_prior_result for full payload]…"
        : text
    lines.push("  Payload:")
    for (const ln of clipped.split("\n")) lines.push(`    ${ln}`)
    lines.push("")
  })
  lines.push("</prior_results>")
  return lines.join("\n")
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}
