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
 * Truncation contract enforced by the writer (NOT the schema):
 *   - row_count = original row count (NOT post-truncation length)
 *   - bytes     = size of the stored result_json string
 *   - truncated = 1 if the writer dropped rows / clipped fields
 * See packages/agent/src/application/shell/agent-cluster/iteration-tool-round.ts for the cap policy.
 */

import { getDb } from "./connection.js"

export interface DbToolResult {
  id?: number
  run_id: string
  session_id: string | null
  tool_call_id: string
  tool_name: string
  args_json: string
  result_json: string
  row_count: number | null
  bytes: number
  truncated: number   // 0 | 1 — SQLite has no bool
  goal_excerpt: string | null
  created_at: string
}

const NON_RECALLABLE_RESULT_PATTERNS = [
  /^DENIED:\s*Policy\b/i,
  /forbidden by governance policy/i,
  /governance-blocked/i,
] as const

/** Write one tool-call result. Idempotent on (run_id, tool_call_id). */
export function saveToolResult(record: Omit<DbToolResult, "id">): void {
  // tool_call_id is provider-issued and unique per call within a run, so
  // (run_id, tool_call_id) is the natural idempotency key. We don't make
  // it a UNIQUE constraint (would require schema migration); instead the
  // INSERT-OR-IGNORE-then-UPDATE pattern keeps writes idempotent at the
  // app layer while a future schema bump can promote it.
  const db = getDb()
  const existing = db
    .prepare("SELECT id FROM tool_results WHERE run_id = ? AND tool_call_id = ? LIMIT 1")
    .get(record.run_id, record.tool_call_id) as { id: number } | undefined
  if (existing) {
    db.prepare(`
      UPDATE tool_results
      SET tool_name=@tool_name, args_json=@args_json, result_json=@result_json,
          row_count=@row_count, bytes=@bytes, truncated=@truncated,
          goal_excerpt=@goal_excerpt, session_id=@session_id, created_at=@created_at
      WHERE id=@id
    `).run({ ...record, id: existing.id })
    return
  }
  db.prepare(`
    INSERT INTO tool_results
      (run_id, session_id, tool_call_id, tool_name, args_json, result_json,
       row_count, bytes, truncated, goal_excerpt, created_at)
    VALUES
      (@run_id, @session_id, @tool_call_id, @tool_name, @args_json, @result_json,
       @row_count, @bytes, @truncated, @goal_excerpt, @created_at)
  `).run(record)
}

/**
 * Load the most recent N tool results for a session, optionally filtered to
 * specific tool names. Ordered newest-first within (run_id desc, id asc) so
 * callers see per-turn locality.
 */
export function loadRecentToolResults(opts: {
  sessionId: string
  limit?: number
  toolNames?: readonly string[]
}): DbToolResult[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200))
  const db = getDb()
  if (opts.toolNames && opts.toolNames.length > 0) {
    const placeholders = opts.toolNames.map(() => "?").join(",")
    return db.prepare(`
      SELECT * FROM tool_results
      WHERE session_id = ? AND tool_name IN (${placeholders})
      ORDER BY id DESC
      LIMIT ?
    `).all(opts.sessionId, ...opts.toolNames, limit) as DbToolResult[]
  }
  return db.prepare(`
    SELECT * FROM tool_results
    WHERE session_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(opts.sessionId, limit) as DbToolResult[]
}

/**
 * Load tool results for a specific run (typically a prior turn). Ordered
 * by insertion order so the agent sees them in the original sequence.
 */
export function loadToolResultsForRun(runId: string): DbToolResult[] {
  return getDb()
    .prepare("SELECT * FROM tool_results WHERE run_id = ? ORDER BY id ASC")
    .all(runId) as DbToolResult[]
}

/**
 * Lookup a single tool result by (run_id, tool_call_id). Used by the
 * recall_prior_result tool when the model passes an explicit reference.
 */
export function getToolResult(runId: string, toolCallId: string): DbToolResult | null {
  return (getDb()
    .prepare("SELECT * FROM tool_results WHERE run_id = ? AND tool_call_id = ?")
    .get(runId, toolCallId) as DbToolResult | undefined) ?? null
}

export function extractToolResultText(json: string): string {
  try {
    const parsed = JSON.parse(json) as { text?: unknown }
    if (typeof parsed.text === "string") return parsed.text
  } catch {
    // fall through
  }
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
