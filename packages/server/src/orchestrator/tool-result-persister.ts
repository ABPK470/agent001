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

import { isRecallableToolText, saveToolResult } from "../db/tool-results.js"
import { MemoryRole, MemorySource, MemoryTier } from "../enums/memory.js"
import { ingestTurn } from "../memory/ingestion.js"

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
  upn: string | null
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
    if (!isRecallableToolText(storedText)) return false

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
    maybePersistReferableArtifact({
      runId: input.runId,
      sessionId: input.sessionId,
      upn: input.upn,
      goal: input.goal,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      rowCount,
      text: storedText,
      isError: input.isError,
    })
    return true
  } catch (err) {
    // Persistence must never crash the run. Failures here are logged by the
    // caller's own try/catch around onToolResult.
    console.warn("[memory] persistToolResult failed:", err instanceof Error ? err.message : String(err))
    return false
  }
}

interface ReferableArtifactInput {
  runId: string
  sessionId: string | null
  upn: string | null
  goal: string
  toolCallId: string
  toolName: string
  rowCount: number | null
  text: string
  isError: boolean
}

function maybePersistReferableArtifact(input: ReferableArtifactInput): void {
  if (input.isError) return
  const summary = summarizeReferableArtifact(input)
  if (!summary) return

  ingestTurn({
    tier: MemoryTier.Episodic,
    role: MemoryRole.Summary,
    content: summary,
    metadata: {
      type: "referable_artifact",
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      rowCount: input.rowCount,
      goal: input.goal,
    },
    source: MemorySource.Tool,
    confidence: 0.82,
    sessionId: input.sessionId,
    runId: input.runId,
    upn: input.upn,
    minSalience: 0.05,
  })
}

function summarizeReferableArtifact(input: ReferableArtifactInput): string | null {
  const goal = input.goal.trim()
  if (!goal) return null

  const table = parseMarkdownTable(input.text)
  if (table) {
    const headers = table.headers.slice(0, 4)
    const labelIndex = findReferentColumn(headers)
    const valueIndex = findMetricColumn(headers)
    const referents = table.rows
      .slice(0, 6)
      .map((row) => {
        const label = row[labelIndex] ?? row[0] ?? ""
        const value = valueIndex >= 0 ? row[valueIndex] ?? "" : ""
        return value ? `${label}=${value}` : label
      })
      .filter(Boolean)

    const lines = [
      `[artifact:data_result] goal=${JSON.stringify(truncateOneLine(goal, 180))}`,
      `tool=${input.toolName} rows=${input.rowCount ?? table.rows.length} columns=${headers.join(", ")}`,
    ]
    if (referents.length > 0) lines.push(`referents: ${referents.join("; ")}`)
    return lines.join("\n")
  }

  if (input.toolName === "export_query_to_file") {
    const oneLine = truncateOneLine(input.text, 240)
    if (!oneLine) return null
    return [
      `[artifact:data_export] goal=${JSON.stringify(truncateOneLine(goal, 180))}`,
      `tool=${input.toolName} rows=${input.rowCount ?? "unknown"}`,
      `summary: ${oneLine}`,
    ].join("\n")
  }

  return null
}

function parseMarkdownTable(text: string): { headers: string[]; rows: string[][] } | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = 0; index <= lines.length - 3; index += 1) {
    const headerLine = lines[index] ?? ""
    const separatorLine = lines[index + 1] ?? ""
    if (!isPipeTableLine(headerLine) || !isTableSeparatorLine(separatorLine)) continue

    const headers = splitMarkdownRow(headerLine)
    if (headers.length === 0) continue

    const rows = takeLeadingPipeTableLines(lines.slice(index + 2))
      .map(splitMarkdownRow)
      .filter((cells) => cells.length > 0)

    if (rows.length === 0) continue
    return { headers, rows }
  }

  return null
}

function splitMarkdownRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
}

function isPipeTableLine(line: string): boolean {
  if (!line.includes("|")) return false
  return splitMarkdownRow(line).length > 0
}

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.includes("-")) return false
  return /^\|?[:\-+\s|]+\|?$/.test(trimmed)
}

function takeLeadingPipeTableLines(lines: readonly string[]): string[] {
  const taken: string[] = []
  for (const line of lines) {
    if (!isPipeTableLine(line)) break
    taken.push(line)
  }
  return taken
}

function findReferentColumn(headers: string[]): number {
  const idx = headers.findIndex((header) => /product|client|name|entity|label|item/i.test(header))
  return idx >= 0 ? idx : 0
}

function findMetricColumn(headers: string[]): number {
  return headers.findIndex((header) => /revenue|profit|margin|amount|value|count|total|share/i.test(header))
}

function truncateOneLine(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > maxLen ? flat.slice(0, maxLen) + "…" : flat
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
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = 0; index <= lines.length - 3; index += 1) {
    if (!isPipeTableLine(lines[index] ?? "") || !isTableSeparatorLine(lines[index + 1] ?? "")) continue
    return takeLeadingPipeTableLines(lines.slice(index + 2)).length
  }
  return null
}
