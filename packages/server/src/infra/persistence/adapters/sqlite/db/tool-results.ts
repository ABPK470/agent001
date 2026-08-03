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

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAllAsync, runExecAsync, runGetAsync } from "../../../schema/execute-async.js"

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
export async function saveToolResult(record: Omit<DbToolResult, "id">): Promise<void> {
  const existingCompiled = getPlatformDb()
    .selectFrom("tool_results")
    .select("id")
    .where("run_id", "=", record.run_id)
    .where("tool_call_id", "=", record.tool_call_id)
    .limit(1)
    .compile()
  const existing = await runGetAsync<{ id: number }>(existingCompiled)
  if (existing) {
    const upd = getPlatformDb()
      .updateTable("tool_results")
      .set({
        tool_name: record.tool_name,
        args_json: record.args_json,
        result_json: record.result_json,
        row_count: record.row_count,
        bytes: record.bytes,
        truncated: record.truncated,
        goal_excerpt: record.goal_excerpt,
        created_at: record.created_at,
      })
      .where("id", "=", existing.id)
      .compile()
    await runExecAsync(upd)
    return
  }
  const ins = getPlatformDb()
    .insertInto("tool_results")
    .values({
      run_id: record.run_id,
      tool_call_id: record.tool_call_id,
      tool_name: record.tool_name,
      args_json: record.args_json,
      result_json: record.result_json,
      row_count: record.row_count,
      bytes: record.bytes,
      truncated: record.truncated,
      goal_excerpt: record.goal_excerpt,
      created_at: record.created_at,
    })
    .compile()
  await runExecAsync(ins)
}

/**
 * Load the most recent N tool results for a thread, optionally filtered to
 * specific tool names. Joins runs so continuity is always thread-scoped.
 */
export async function loadRecentToolResultsForThread(opts: {
  threadId: string
  upn: string
  limit?: number
  toolNames?: readonly string[]
}): Promise<DbToolResult[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200))
  let query = getPlatformDb()
    .selectFrom("tool_results as tr")
    .innerJoin("runs as r", "r.id", "tr.run_id")
    .selectAll("tr")
    .where("r.thread_id", "=", opts.threadId)
    .where("r.upn", "=", opts.upn)
  if (opts.toolNames && opts.toolNames.length > 0) {
    query = query.where("tr.tool_name", "in", [...opts.toolNames])
  }
  const compiled = query.orderBy("tr.id", "desc").limit(limit).compile()
  return await runAllAsync<DbToolResult>(compiled)
}

export async function loadToolResultsForRun(runId: string): Promise<DbToolResult[]> {
  const compiled = getPlatformDb()
    .selectFrom("tool_results")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("id", "asc")
    .compile()
  return await runAllAsync<DbToolResult>(compiled)
}

export async function getToolResult(runId: string, toolCallId: string): Promise<DbToolResult | null> {
  const compiled = getPlatformDb()
    .selectFrom("tool_results")
    .selectAll()
    .where("run_id", "=", runId)
    .where("tool_call_id", "=", toolCallId)
    .compile()
  return await runGetAsync<DbToolResult>(compiled) ?? null
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
