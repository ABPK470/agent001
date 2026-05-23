/**
 * tool-result-persister.ts — server-side hook that captures every tool-call
 * payload into the `tool_results` table for cross-turn grounding.
 *
 * Phase 9 (no-amnesia memory) writer. The agent loop calls this via the
 * `onToolResult` AgentConfig callback. We deliberately:
 *   - Persist a curated subset of tools (CAPTURED_TOOLS). General tools like
 *     read_file have their own provenance (the file); persisting them would
 *     bloat the table.
 *   - Cap payload size to PERSIST_BYTES_CAP per call. Anything larger is
 *     truncated with a marker — the goal is "enough rows to ground on",
 *     not full mirroring.
 *   - Stash the goal_excerpt so the recall tool can disambiguate later.
 *   - Swallow all errors. A SQLite hiccup must not break a live run.
 */

import { saveToolResult } from "../db/tool-results.js"

/**
 * Tools whose results we persist for cross-turn grounding. Keep this list
 * tight — every entry is a row written on EVERY call across every run.
 *
 * `query_mssql` / `export_query_to_file` are the primary motivators (they
 * are the source of the "chart-from-prose" hallucination). Catalog / profile
 * tools are intentionally EXCLUDED because they are already mirrored into
 * `tool_knowledge` with semantic indexing.
 */
const CAPTURED_TOOLS = new Set<string>([
  "query_mssql",
  "export_query_to_file",
])

/** Per-call payload cap. 64 KB matches the truncation budget in the plan. */
const PERSIST_BYTES_CAP = 64 * 1024

/** Goal excerpt length stored alongside the row (for human-readable recall). */
const GOAL_EXCERPT_CAP = 240

export interface PersistToolResultInput {
  runId: string
  sessionId: string | null
  goal: string
  iteration: number
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result: string
  isError: boolean
}

/**
 * Capture one tool-call result. Never throws.
 *
 * @returns true if the call was persisted, false otherwise (filtered or error).
 */
export function persistToolResult(input: PersistToolResultInput): boolean {
  try {
    if (!CAPTURED_TOOLS.has(input.toolName)) return false

    const rawText = input.result ?? ""
    const rawBytes = Buffer.byteLength(rawText, "utf8")
    const truncated = rawBytes > PERSIST_BYTES_CAP
    const storedText = truncated
      ? rawText.slice(0, PERSIST_BYTES_CAP) + "\n\n…[truncated by tool-result persister]…"
      : rawText

    // Best-effort row-count extraction. The text result for query_mssql is a
    // markdown table — counting lines past the header gives a reasonable
    // estimate. For export_query_to_file we look for an explicit count.
    const rowCount = estimateRowCount(input.toolName, storedText)

    saveToolResult({
      run_id:       input.runId,
      session_id:   input.sessionId,
      tool_call_id: input.toolCallId,
      tool_name:    input.toolName,
      args_json:    safeStringify(input.args),
      // Wrap raw text in a JSON object so the schema (TEXT NOT NULL) holds
      // valid JSON. Future structured-row enhancements (Phase A2) populate
      // a `rows` array alongside `text`.
      result_json:  JSON.stringify({ text: storedText, isError: input.isError }),
      row_count:    rowCount,
      bytes:        Buffer.byteLength(storedText, "utf8"),
      truncated:    truncated ? 1 : 0,
      goal_excerpt: input.goal.slice(0, GOAL_EXCERPT_CAP),
      created_at:   new Date().toISOString(),
    })
    return true
  } catch {
    // Persistence must never crash the run. Failures here are logged by the
    // caller's own try/catch around onToolResult.
    return false
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return "{}"
  }
}

/**
 * Heuristic row-count extractor. Returns null when we can't estimate.
 * Intentionally cheap — this runs on every tool call.
 */
function estimateRowCount(toolName: string, text: string): number | null {
  if (toolName === "export_query_to_file") {
    // export_query_to_file returns text like "Exported 12345 rows to ..."
    const m = /Exported\s+([\d,]+)\s+rows/i.exec(text)
    if (m) return Number(m[1]!.replace(/,/g, ""))
  }
  // For query_mssql the text contains a markdown table. Count pipe-delimited
  // data rows (excluding the header + separator). This is a lower-bound but
  // useful for downstream tools.
  const lines = text.split(/\r?\n/).filter((l) => l.trimStart().startsWith("|"))
  if (lines.length >= 3) {
    // First two lines are header + separator (---).
    return Math.max(0, lines.length - 2)
  }
  return null
}
