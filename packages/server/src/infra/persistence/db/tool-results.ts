/**
 * tool_results — persistence for structured tool-call payloads.
 *
 * Why this exists (no-amnesia grounding):
 * Before this table existed, the only cross-turn record of a tool's output
 * was the model's own prose paraphrase in `runs.answer`. Re-injected into
 * the next turn as `<prior_turns>`, that paraphrase became "evidence" the
 * model treated as ground truth — and confabulated charts from it. This
 * table stores the raw structured payload of every tool call so
 * `<prior_results>` (and the `recall_prior_result` tool) can ground later
 * turns on actual rows.
 *
 * Continuity scope: thread_id + upn via JOIN on runs (not cookie session).
 */

import { getDb } from "../connection.js"

export interface DbToolResult {
  id?: number
  run_id: string
  tool_call_id: string
  tool_name: string
  args_json: string
  result_json: string
  row_count: number | null
  bytes: number
  truncated: number // 0 | 1 — SQLite has no bool
  goal_excerpt: string | null
  created_at: string
}

const NON_RECALLABLE_RESULT_PATTERNS = [
  /^DENIED:\s*Policy\b/i,
  /forbidden by governance policy/i,
  /governance-blocked/i
] as const

/** Write one tool-call result. Idempotent on (run_id, tool_call_id). */
export function saveToolResult(record: Omit<DbToolResult, "id">): void {
  const db = getDb()
  const existing = db
    .prepare("SELECT id FROM tool_results WHERE run_id = ? AND tool_call_id = ? LIMIT 1")
    .get(record.run_id, record.tool_call_id) as { id: number } | undefined
  if (existing) {
    db.prepare(
      `
      UPDATE tool_results
      SET tool_name=@tool_name, args_json=@args_json, result_json=@result_json,
          row_count=@row_count, bytes=@bytes, truncated=@truncated,
          goal_excerpt=@goal_excerpt, created_at=@created_at
      WHERE id=@id
    `
    ).run({ ...record, id: existing.id })
    return
  }
  db.prepare(
    `
    INSERT INTO tool_results
      (run_id, tool_call_id, tool_name, args_json, result_json,
       row_count, bytes, truncated, goal_excerpt, created_at)
    VALUES
      (@run_id, @tool_call_id, @tool_name, @args_json, @result_json,
       @row_count, @bytes, @truncated, @goal_excerpt, @created_at)
  `
  ).run(record)
}

/**
 * Load the most recent N tool results for a thread, optionally filtered to
 * specific tool names. Joins runs so continuity is always thread-scoped.
 */
export function loadRecentToolResultsForThread(opts: {
  threadId: string
  upn: string
  limit?: number
  toolNames?: readonly string[]
}): DbToolResult[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200))
  const db = getDb()
  const toolFilter =
    opts.toolNames && opts.toolNames.length > 0
      ? ` AND tr.tool_name IN (${opts.toolNames.map(() => "?").join(",")})`
      : ""
  const params: Array<string | number> = [opts.threadId, opts.upn]
  if (opts.toolNames && opts.toolNames.length > 0) params.push(...opts.toolNames)
  params.push(limit)
  return db
    .prepare(
      `
      SELECT tr.*
      FROM tool_results tr
      INNER JOIN runs r ON r.id = tr.run_id
      WHERE r.thread_id = ?
        AND r.upn = ?
        ${toolFilter}
      ORDER BY tr.id DESC
      LIMIT ?
    `
    )
    .all(...params) as DbToolResult[]
}

export function loadToolResultsForRun(runId: string): DbToolResult[] {
  return getDb()
    .prepare("SELECT * FROM tool_results WHERE run_id = ? ORDER BY id ASC")
    .all(runId) as DbToolResult[]
}

export function getToolResult(runId: string, toolCallId: string): DbToolResult | null {
  return (
    (getDb()
      .prepare("SELECT * FROM tool_results WHERE run_id = ? AND tool_call_id = ?")
      .get(runId, toolCallId) as DbToolResult | undefined) ?? null
  )
}

export function extractToolResultText(json: string): string {
  try {
    const parsed = JSON.parse(json) as { text?: unknown }
    if (typeof parsed.text === "string") return parsed.text
  } catch (err: unknown) { console.error("[mia]", err) }
  return json
}

export function isRecallableToolText(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  return !NON_RECALLABLE_RESULT_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function isRecallableToolResult(row: Pick<DbToolResult, "result_json">): boolean {
  return isRecallableToolText(extractToolResultText(row.result_json))
}
