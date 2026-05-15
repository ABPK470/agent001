/**
 * Run persistence — CRUD for agent runs, checkpoints, audit logs, traces.
 */

import { isRunStatus, RUN_STATUSES, RunStatus } from "@mia/agent"
import type { Run } from "@mia/shared-types"
import { getCurrentSession } from "../auth/context.js"
import { getDb } from "./connection.js"

// ── Run queries ──────────────────────────────────────────────────

/** A persisted run row. `status` is enum-bound so the DB layer cannot
 *  accept any string the agent lifecycle does not declare. The runtime
 *  guard inside saveRun() backs this up for callers that erase types
 *  (e.g. routes deserialising arbitrary input). */
export interface DbRun {
  id: string
  goal: string
  status: RunStatus
  answer: string | null
  step_count: number
  error: string | null
  parent_run_id: string | null
  agent_id: string | null
  created_at: string
  completed_at: string | null
  session_id?: string | null
  upn?: string | null
  display_name?: string | null
}

// IMPORTANT: this is a true upsert (INSERT … ON CONFLICT DO UPDATE), NOT
// `INSERT OR REPLACE`. With the v14 schema redesign, several child tables
// (trace_entries, audit_log, logs, notifications, …) FK to runs(id) with
// `ON DELETE CASCADE`. `INSERT OR REPLACE` is implemented as DELETE + INSERT
// in SQLite, so each status update would silently wipe the entire trace,
// audit log, and stored logs for that run — leaving every UI widget
// (MIA-CHAT, IOE, StepTimeline, AgentViz, …) blank. ON CONFLICT DO UPDATE
// updates the row in place and does not fire cascade deletes.
const upsertRun = () => getDb().prepare(`
  INSERT INTO runs (id, goal, status, answer, step_count, error, parent_run_id, agent_id, created_at, completed_at, session_id, upn, display_name)
  VALUES (@id, @goal, @status, @answer, @step_count, @error, @parent_run_id, @agent_id, @created_at, @completed_at, @session_id, @upn, @display_name)
  ON CONFLICT(id) DO UPDATE SET
    goal          = excluded.goal,
    status        = excluded.status,
    answer        = excluded.answer,
    step_count    = excluded.step_count,
    error         = excluded.error,
    parent_run_id = excluded.parent_run_id,
    agent_id      = excluded.agent_id,
    created_at    = excluded.created_at,
    completed_at  = excluded.completed_at,
    session_id    = excluded.session_id,
    upn           = excluded.upn,
    display_name  = excluded.display_name
`)

export function saveRun(run: DbRun): void {
  // Hard runtime check at the DB write boundary. The TypeScript signature
  // already constrains DbRun.status to RunStatus, but boundary writes
  // (HTTP/SSE deserialisation, JSON.parse from checkpoints, etc.) erase
  // types — so we still validate at runtime to make drift impossible.
  if (!isRunStatus(run.status)) {
    throw new Error(
      `runs.status must be one of [${RUN_STATUSES.join(", ")}]; got "${String(run.status)}" for run ${run.id}`,
    )
  }
  // Stamp session/upn from AsyncLocalStorage if the caller didn't provide them.
  // Existing rows keep their stamp on update (we read first via getRun and merge).
  const existing = getDb().prepare("SELECT session_id, upn, display_name FROM runs WHERE id = ?").get(run.id) as
    { session_id: string | null; upn: string | null; display_name: string | null } | undefined
  const ctx = getCurrentSession()
  upsertRun().run({
    ...run,
    session_id:   run.session_id   ?? existing?.session_id   ?? ctx?.sid         ?? null,
    upn:          run.upn          ?? existing?.upn          ?? ctx?.upn         ?? null,
    display_name: run.display_name ?? existing?.display_name ?? ctx?.displayName ?? null,
  })
}

export function getRun(id: string): DbRun | undefined {
  return getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id) as DbRun | undefined
}

export function listRuns(limit = 100, offset = 0): DbRun[] {
  return getDb()
    .prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ? OFFSET ?")
    .all(limit, offset) as DbRun[]
}

export interface DbRunWithUsage extends DbRun {
  total_tokens: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  llm_calls: number | null
}

/**
 * Map a persisted run row to the wire `Run` shape consumed by the UI.
 *
 * Token usage and the workspace-diff count are passed in as `extras`
 * because they live in adjacent tables (token_usage) or transient
 * orchestrator state (pending diff) and are joined/computed by the
 * caller. Keeping the mapper pure means routes own the policy of
 * "where to source these numbers from" while the field names + types
 * stay in one place.
 */
export interface RunWireExtras {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  llmCalls: number
  pendingWorkspaceChanges: number
}

export function dbRunToWire(row: DbRun, extras: RunWireExtras): Run {
  return {
    id:                      row.id,
    goal:                    row.goal,
    status:                   row.status,
    answer:                  row.answer,
    stepCount:               row.step_count,
    error:                   row.error,
    parentRunId:             row.parent_run_id,
    agentId:                 row.agent_id ?? null,
    createdAt:               row.created_at,
    completedAt:             row.completed_at,
    totalTokens:             extras.totalTokens,
    promptTokens:            extras.promptTokens,
    completionTokens:        extras.completionTokens,
    llmCalls:                extras.llmCalls,
    pendingWorkspaceChanges: extras.pendingWorkspaceChanges,
  }
}

export function listRunsWithUsage(limit = 100, offset = 0): DbRunWithUsage[] {
  return getDb()
    .prepare(`
      SELECT r.*, t.total_tokens, t.prompt_tokens, t.completion_tokens, t.llm_calls
      FROM runs r
      LEFT JOIN token_usage t ON t.run_id = r.id
      ORDER BY r.created_at DESC LIMIT ? OFFSET ?
    `)
    .all(limit, offset) as DbRunWithUsage[]
}

/**
 * Scoped listing for non-admin visitors. Matches by upn when set, otherwise
 * by session_id (so anonymous-cookie users only see runs they themselves
 * started in this browser session).
 */
export function listRunsWithUsageForUser(
  opts: { upn?: string | null; sid?: string | null; sessionOnly?: boolean },
  limit = 100,
  offset = 0,
): DbRunWithUsage[] {
  const { upn, sid, sessionOnly } = opts
  if (!upn && !sid) return []
  // sessionOnly=true narrows to "this chat thread" \u2014 the runs that share the
  // current cookie sid. Default behaviour (sessionOnly=false) shows every run
  // for this UPN across all login sessions, with the sid fallback for users
  // without a stable identity.
  if (sessionOnly && sid) {
    return getDb()
      .prepare(`
        SELECT r.*, t.total_tokens, t.prompt_tokens, t.completion_tokens, t.llm_calls
        FROM runs r
        LEFT JOIN token_usage t ON t.run_id = r.id
        WHERE r.session_id = @sid
        ORDER BY r.created_at DESC LIMIT @limit OFFSET @offset
      `)
      .all({ sid, limit, offset }) as DbRunWithUsage[]
  }
  return getDb()
    .prepare(`
      SELECT r.*, t.total_tokens, t.prompt_tokens, t.completion_tokens, t.llm_calls
      FROM runs r
      LEFT JOIN token_usage t ON t.run_id = r.id
      WHERE (@upn IS NOT NULL AND r.upn = @upn)
         OR (@upn IS NULL AND @sid IS NOT NULL AND r.session_id = @sid)
      ORDER BY r.created_at DESC LIMIT @limit OFFSET @offset
    `)
    .all({ upn: upn ?? null, sid: sid ?? null, limit, offset }) as DbRunWithUsage[]
}

/** Every non-terminal RunStatus — anything still in this set after a
 *  server restart is by definition stale and should be marked failed. */
const NON_TERMINAL_RUN_STATUSES = [
  RunStatus.Pending,
  RunStatus.Planning,
  RunStatus.Running,
  RunStatus.WaitingForApproval,
] as const

export function findStaleRuns(): DbRun[] {
  const placeholders = NON_TERMINAL_RUN_STATUSES.map(() => "?").join(", ")
  return getDb()
    .prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...NON_TERMINAL_RUN_STATUSES) as DbRun[]
}

export function markRunCrashed(runId: string): void {
  getDb().prepare(
    "UPDATE runs SET status = ?, error = 'Server restarted \u2014 run interrupted', completed_at = datetime('now') WHERE id = ?"
  ).run(RunStatus.Failed, runId)
}

/** Boot-time hygiene: any row whose status is NOT a known RunStatus
 *  (e.g. legacy 'queued' or anything mistakenly written before the
 *  enum guard existed) gets normalised to 'failed' so the lifecycle
 *  invariants downstream code relies on remain true. */
export function normaliseUnknownRunStatuses(): number {
  const placeholders = RUN_STATUSES.map(() => "?").join(", ")
  const res = getDb().prepare(
    `UPDATE runs SET status = ?, error = COALESCE(error, 'Unknown legacy status \u2014 normalised on boot'), completed_at = COALESCE(completed_at, datetime('now')) WHERE status NOT IN (${placeholders})`,
  ).run(RunStatus.Failed, ...RUN_STATUSES)
  return res.changes
}

/**
 * Mark a run as cancelled in the DB immediately.
 *
 * The agent loop also persists status='cancelled' once the abort signal is
 * observed, but if the loop is blocked (e.g. on an LLM stream that ignores
 * the signal) that may never happen — leaving the row stuck on 'running'
 * across server restarts. Calling this from the orchestrator's cancelRun
 * makes the DB state match the user's intent regardless of loop progress.
 *
 * Only updates rows that are still in an active state, so it can't clobber
 * a run that has already finished, failed, or completed in the meantime.
 */
export function markRunCancelled(runId: string): void {
  const placeholders = NON_TERMINAL_RUN_STATUSES.map(() => "?").join(", ")
  getDb().prepare(
    `UPDATE runs SET status = ?, completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ? AND status IN (${placeholders})`,
  ).run(RunStatus.Cancelled, runId, ...NON_TERMINAL_RUN_STATUSES)
}

// ── Audit queries ────────────────────────────────────────────────

export interface DbAudit {
  id?: number
  run_id: string
  actor: string
  action: string
  detail: string
  timestamp: string
}

export function saveAudit(entry: Omit<DbAudit, "id">): void {
  getDb().prepare(`
    INSERT INTO audit_log (run_id, actor, action, detail, timestamp)
    VALUES (@run_id, @actor, @action, @detail, @timestamp)
  `).run(entry)
}

export function getAuditLog(runId: string): DbAudit[] {
  return getDb()
    .prepare("SELECT * FROM audit_log WHERE run_id = ? ORDER BY timestamp")
    .all(runId) as DbAudit[]
}

// ── Checkpoint queries ───────────────────────────────────────────

export interface DbCheckpoint {
  run_id: string
  messages: string
  iteration: number
  step_counter: number
  updated_at: string
}

export function saveCheckpoint(cp: DbCheckpoint): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO checkpoints (run_id, messages, iteration, step_counter, updated_at)
    VALUES (@run_id, @messages, @iteration, @step_counter, @updated_at)
  `).run(cp)
}

export function getCheckpoint(runId: string): DbCheckpoint | undefined {
  return getDb()
    .prepare("SELECT * FROM checkpoints WHERE run_id = ?")
    .get(runId) as DbCheckpoint | undefined
}

// ── Log queries ──────────────────────────────────────────────────

export interface DbLog {
  id?: number
  run_id: string
  level: string
  message: string
  timestamp: string
}

export function saveLog(entry: Omit<DbLog, "id">): void {
  getDb().prepare(`
    INSERT INTO logs (run_id, level, message, timestamp)
    VALUES (@run_id, @level, @message, @timestamp)
  `).run(entry)
}

export function getLogs(runId: string, level?: string): DbLog[] {
  if (level) {
    return getDb()
      .prepare("SELECT * FROM logs WHERE run_id = ? AND level = ? ORDER BY timestamp")
      .all(runId, level) as DbLog[]
  }
  return getDb()
    .prepare("SELECT * FROM logs WHERE run_id = ? ORDER BY timestamp")
    .all(runId) as DbLog[]
}

// ── Trace entry queries ──────────────────────────────────────────

export interface DbTraceEntry {
  id?: number
  run_id: string
  seq: number
  data: string
  created_at: string
}

export function saveTraceEntry(entry: Omit<DbTraceEntry, "id">): void {
  getDb().prepare(`
    INSERT INTO trace_entries (run_id, seq, data, created_at)
    VALUES (@run_id, @seq, @data, @created_at)
  `).run(entry)
}

export function getTraceEntries(runId: string): DbTraceEntry[] {
  return getDb()
    .prepare("SELECT * FROM trace_entries WHERE run_id = ? ORDER BY seq")
    .all(runId) as DbTraceEntry[]
}

// ── Token usage queries ──────────────────────────────────────────

export interface DbTokenUsage {
  run_id: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  llm_calls: number
  model: string
  created_at: string
}

export function saveTokenUsage(usage: DbTokenUsage): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO token_usage (run_id, prompt_tokens, completion_tokens, total_tokens, llm_calls, model, created_at)
    VALUES (@run_id, @prompt_tokens, @completion_tokens, @total_tokens, @llm_calls, @model, @created_at)
  `).run(usage)
}

export function getTokenUsage(runId: string): DbTokenUsage | undefined {
  return getDb()
    .prepare("SELECT * FROM token_usage WHERE run_id = ?")
    .get(runId) as DbTokenUsage | undefined
}

export function listTokenUsage(limit = 100): DbTokenUsage[] {
  return getDb()
    .prepare("SELECT * FROM token_usage ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbTokenUsage[]
}

export interface UsageTotals {
  total_prompt_tokens: number
  total_completion_tokens: number
  total_tokens: number
  total_llm_calls: number
  run_count: number
  completed_runs: number
  failed_runs: number
}

export function getUsageTotals(): UsageTotals {
  const tokens = getDb()
    .prepare("SELECT COALESCE(SUM(prompt_tokens),0) as total_prompt_tokens, COALESCE(SUM(completion_tokens),0) as total_completion_tokens, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(llm_calls),0) as total_llm_calls FROM token_usage")
    .get() as Omit<UsageTotals, "run_count" | "completed_runs" | "failed_runs">
  const runStats = getDb()
    .prepare("SELECT COUNT(*) as run_count, COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),0) as completed_runs, COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),0) as failed_runs FROM runs")
    .get() as { run_count: number; completed_runs: number; failed_runs: number }
  return { ...tokens, ...runStats }
}
