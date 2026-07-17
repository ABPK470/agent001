/**
 * prior-results-block.ts — load and render the `<prior_results>` system
 * anchor that gives the agent loop access to actual structured tool
 * payloads from earlier turns in the same thread.
 *
 * Continuity is scoped exclusively by `thread_id` (see continuity.ts).
 */

import type { DbToolResult } from "../../../../platform/persistence/tool-results.js"
import {
  extractToolResultText,
  isRecallableToolResult,
  loadRecentToolResultsForThread
} from "../../../../platform/persistence/tool-results.js"

/** Tools whose results we surface in <prior_results>. Mirrors the writer. */
const SURFACED_TOOLS = ["query_mssql", "export_query_to_file"] as const

/** Max number of prior tool results rendered into the anchor. */
const MAX_RESULTS = 6

/** Per-result clipped text length. Keeps the anchor inside the token budget. */
const PER_RESULT_CHARS = 1500

export interface LoadPriorResultsOptions {
  readonly threadId: string
  readonly upn: string
  /** Exclude tool results from the current run. */
  readonly excludeRunId?: string | null
}

/** Load recent structured tool results for the thread, newest first. */
export function loadPriorResults(opts: LoadPriorResultsOptions): DbToolResult[] {
  if (!opts.threadId || !opts.upn) return []
  const rows = loadRecentToolResultsForThread({
    threadId: opts.threadId,
    upn: opts.upn,
    limit: MAX_RESULTS * 4,
    toolNames: SURFACED_TOOLS
  })
  const excludeRunId = opts.excludeRunId ?? null
  return rows.filter((r) => r.run_id !== excludeRunId && isRecallableToolResult(r)).slice(0, MAX_RESULTS)
}

/**
 * Render the `<prior_results>` system anchor block. Returns empty string
 * when there are no results to surface.
 */
export function renderPriorResultsBlock(results: readonly DbToolResult[]): string {
  if (results.length === 0) return ""
  const lines: string[] = [
    "<prior_results>",
    "Structured tool-call payloads from earlier turns in THIS thread. These",
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
