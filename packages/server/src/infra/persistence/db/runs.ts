/**
 * Run persistence — CRUD for agent runs, checkpoints, audit logs, traces.
 */

import { isRunStatus, RUN_STATUSES, RunStatus } from "@mia/agent"
import type { Run } from "@mia/shared-types"
import { getDb } from "../connection.js"

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
  created_at: string
  completed_at: string | null
  thread_id?: string | null
  upn?: string | null
  display_name?: string | null
}

// IMPORTANT: this is a true upsert (INSERT … ON CONFLICT DO UPDATE), NOT
// `INSERT OR REPLACE`. With the v14 schema redesign, several child tables
// (trace_entries, audit_log, run_log, notifications, …) FK to runs(id) with
// `ON DELETE CASCADE`. `INSERT OR REPLACE` is implemented as DELETE + INSERT
// in SQLite, so each status update would silently wipe the entire trace,
// audit log, and stored logs for that run — leaving every UI widget
// (MIA-CHAT, IOE, StepTimeline, AgentViz, …) blank. ON CONFLICT DO UPDATE
// updates the row in place and does not fire cascade deletes.
const upsertRun = () =>
  getDb().prepare(`
  INSERT INTO runs (id, goal, status, answer, step_count, error, parent_run_id, created_at, completed_at, thread_id, upn, display_name)
  VALUES (@id, @goal, @status, @answer, @step_count, @error, @parent_run_id, @created_at, @completed_at, @thread_id, @upn, @display_name)
  ON CONFLICT(id) DO UPDATE SET
    goal          = excluded.goal,
    status        = excluded.status,
    answer        = excluded.answer,
    step_count    = excluded.step_count,
    error         = excluded.error,
    parent_run_id = excluded.parent_run_id,
    created_at    = excluded.created_at,
    completed_at  = excluded.completed_at,
    thread_id     = excluded.thread_id,
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
      `runs.status must be one of [${RUN_STATUSES.join(", ")}]; got "${String(run.status)}" for run ${run.id}`
    )
  }
  const existing = getDb()
    .prepare("SELECT thread_id, upn, display_name FROM runs WHERE id = ?")
    .get(run.id) as {
    thread_id: string | null
    upn: string | null
    display_name: string | null
  } | undefined
  upsertRun().run({
    ...run,
    thread_id: run.thread_id ?? existing?.thread_id ?? null,
    upn: run.upn ?? existing?.upn ?? null,
    display_name: run.display_name ?? existing?.display_name ?? null
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
    id: row.id,
    goal: row.goal,
    status: row.status,
    answer: row.answer,
    stepCount: row.step_count,
    error: row.error,
    parentRunId: row.parent_run_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    totalTokens: extras.totalTokens,
    promptTokens: extras.promptTokens,
    completionTokens: extras.completionTokens,
    llmCalls: extras.llmCalls,
    pendingWorkspaceChanges: extras.pendingWorkspaceChanges,
    upn: row.upn ?? null,
    displayName: row.display_name ?? null,
    threadId: row.thread_id ?? null
  }
}

export function listRunsWithUsageForThread(
  threadId: string,
  limit = 200,
  offset = 0
): DbRunWithUsage[] {
  return getDb()
    .prepare(
      `
      SELECT r.*, t.total_tokens, t.prompt_tokens, t.completion_tokens, t.llm_calls
      FROM runs r
      LEFT JOIN token_usage t ON t.run_id = r.id
      WHERE r.thread_id = @threadId
      ORDER BY r.created_at DESC
      LIMIT @limit OFFSET @offset
    `
    )
    .all({ threadId, limit, offset }) as DbRunWithUsage[]
}

export function listRunsWithUsage(limit = 100, offset = 0): DbRunWithUsage[] {
  return getDb()
    .prepare(
      `
      SELECT r.*, t.total_tokens, t.prompt_tokens, t.completion_tokens, t.llm_calls
      FROM runs r
      LEFT JOIN token_usage t ON t.run_id = r.id
      ORDER BY r.created_at DESC LIMIT ? OFFSET ?
    `
    )
    .all(limit, offset) as DbRunWithUsage[]
}

/** Scoped listing for authenticated visitors — upn only (no session_id fallback). */
export function listRunsWithUsageForUser(
  opts: { upn?: string | null },
  limit = 100,
  offset = 0
): DbRunWithUsage[] {
  const { upn } = opts
  if (!upn) return []
  return getDb()
    .prepare(
      `
      SELECT r.*, t.total_tokens, t.prompt_tokens, t.completion_tokens, t.llm_calls
      FROM runs r
      LEFT JOIN token_usage t ON t.run_id = r.id
      WHERE r.upn = @upn
      ORDER BY r.created_at DESC LIMIT @limit OFFSET @offset
    `
    )
    .all({ upn, limit, offset }) as DbRunWithUsage[]
}

/** Every non-terminal RunStatus — anything still in this set after a
 *  server restart is by definition stale and should be marked failed. */
const NON_TERMINAL_RUN_STATUSES = [
  RunStatus.Pending,
  RunStatus.Planning,
  RunStatus.Running,
  RunStatus.WaitingForApproval
] as const

export function findStaleRuns(): DbRun[] {
  const placeholders = NON_TERMINAL_RUN_STATUSES.map(() => "?").join(", ")
  return getDb()
    .prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at DESC`)
    .all(...NON_TERMINAL_RUN_STATUSES) as DbRun[]
}

export function markRunCrashed(runId: string): void {
  getDb()
    .prepare(
      "UPDATE runs SET status = ?, error = 'Server restarted \u2014 run interrupted', completed_at = datetime('now') WHERE id = ?"
    )
    .run(RunStatus.Crashed, runId)
}

/** Boot-time hygiene: any row whose status is NOT a known RunStatus
 *  (e.g. legacy 'queued' or anything mistakenly written before the
 *  enum guard existed) gets normalised to 'failed' so the lifecycle
 *  invariants downstream code relies on remain true. */
export function normaliseUnknownRunStatuses(): number {
  const placeholders = RUN_STATUSES.map(() => "?").join(", ")
  const res = getDb()
    .prepare(
      `UPDATE runs SET status = ?, error = COALESCE(error, 'Unknown legacy status \u2014 normalised on boot'), completed_at = COALESCE(completed_at, datetime('now')) WHERE status NOT IN (${placeholders})`
    )
    .run(RunStatus.Failed, ...RUN_STATUSES)
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
  getDb()
    .prepare(
      `UPDATE runs SET status = ?, completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ? AND status IN (${placeholders})`
    )
    .run(RunStatus.Cancelled, runId, ...NON_TERMINAL_RUN_STATUSES)
}

// ── Audit queries ────────────────────────────────────────────────

export type AuditScopeType = "run" | "admin"

export interface DbAudit {
  id?: number
  run_id: string | null
  scope_type: AuditScopeType
  scope_id: string | null
  actor: string
  action: string
  detail: string
  timestamp: string
}

export function saveAudit(
  entry: Omit<DbAudit, "id" | "scope_type" | "scope_id"> & {
    scope_type?: AuditScopeType
    scope_id?: string | null
  }
): void {
  const scopeType: AuditScopeType = entry.scope_type ?? (entry.run_id ? "run" : "admin")
  const scopeId = entry.scope_id ?? (scopeType === "run" ? entry.run_id : "platform")
  getDb()
    .prepare(
      `
    INSERT INTO audit_log (run_id, scope_type, scope_id, actor, action, detail, timestamp)
    VALUES (@run_id, @scope_type, @scope_id, @actor, @action, @detail, @timestamp)
  `
    )
    .run({
      ...entry,
      scope_type: scopeType,
      scope_id: scopeId
    })
}

export function saveAdminAudit(
  entry: Omit<DbAudit, "id" | "run_id" | "scope_type"> & { scope_id?: string | null }
): void {
  saveAudit({
    run_id: null,
    actor: entry.actor,
    action: entry.action,
    detail: entry.detail,
    timestamp: entry.timestamp,
    scope_type: "admin",
    scope_id: entry.scope_id ?? "platform"
  })
}

export function getAuditLog(runId: string): DbAudit[] {
  return getDb()
    .prepare("SELECT * FROM audit_log WHERE scope_type = 'run' AND run_id = ? ORDER BY timestamp")
    .all(runId) as DbAudit[]
}

/** Admin cross-run / cross-scope audit browser filters. */
export interface AuditLogFilters {
  scopeType?: AuditScopeType
  scopeId?: string
  runId?: string
  threadId?: string
  /**
   * Platform user (UPN) — matches run owner or admin-scope actor.
   * Proxy identity and signed-up accounts are the same key.
   */
  user?: string
  /** Exact action or prefix ending with `.` (e.g. `policy.`). */
  action?: string
  search?: string
  from?: string
  to?: string
}

export type AuditLogSort = "timestamp_desc" | "timestamp_asc"

export interface ListAuditLogPaginatedInput extends AuditLogFilters {
  page: number
  pageSize: number
  sort?: AuditLogSort
}

export interface DbAuditWithRun extends DbAudit {
  run_goal: string | null
  run_status: string | null
  run_upn: string | null
  run_display_name: string | null
  thread_id: string | null
  thread_title: string | null
}

function buildAuditLogWhere(filters: AuditLogFilters): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  if (filters.scopeType === "run" || filters.scopeType === "admin") {
    clauses.push("a.scope_type = ?")
    params.push(filters.scopeType)
  }
  if (filters.scopeId?.trim()) {
    clauses.push("a.scope_id = ?")
    params.push(filters.scopeId.trim())
  }
  if (filters.runId?.trim()) {
    clauses.push("a.run_id = ?")
    params.push(filters.runId.trim())
  }
  if (filters.threadId?.trim()) {
    clauses.push("r.thread_id = ?")
    params.push(filters.threadId.trim())
  }
  if (filters.user?.trim()) {
    const upn = filters.user.trim()
    // One identity: run owner (operator work) or admin actor UPN.
    clauses.push("(r.upn = ? OR a.actor = ?)")
    params.push(upn, upn)
  }
  const action = filters.action?.trim()
  if (action) {
    if (action.endsWith(".")) {
      clauses.push("a.action LIKE ?")
      params.push(`${action}%`)
    } else {
      clauses.push("a.action = ?")
      params.push(action)
    }
  }
  if (filters.from?.trim()) {
    const from = filters.from.trim()
    // Date-only inputs become start-of-day ISO so they compare correctly
    // against timestamps that use `T` (string compare: `T` > space).
    clauses.push("a.timestamp >= ?")
    params.push(from.includes("T") ? from : `${from}T00:00:00`)
  }
  if (filters.to?.trim()) {
    const to = filters.to.trim()
    clauses.push("a.timestamp <= ?")
    params.push(to.includes("T") ? to : `${to}T23:59:59.999`)
  }
  const search = filters.search?.trim()
  if (search) {
    const q = `%${search}%`
    clauses.push(
      `(a.action LIKE ? OR a.actor LIKE ? OR a.detail LIKE ? OR a.run_id LIKE ? OR a.scope_id LIKE ? OR IFNULL(r.goal, '') LIKE ? OR IFNULL(r.upn, '') LIKE ?)`,
    )
    params.push(q, q, q, q, q, q, q)
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  }
}

const AUDIT_LIST_FROM = `
  FROM audit_log a
  LEFT JOIN runs r ON r.id = a.run_id
  LEFT JOIN threads t ON t.id = r.thread_id
`

const AUDIT_LIST_SELECT = `
  SELECT
    a.id, a.run_id, a.scope_type, a.scope_id, a.actor, a.action, a.detail, a.timestamp,
    r.goal AS run_goal, r.status AS run_status, r.upn AS run_upn,
    r.display_name AS run_display_name,
    r.thread_id AS thread_id, t.title AS thread_title
  ${AUDIT_LIST_FROM}
`

export function countAuditLog(filters: AuditLogFilters = {}): number {
  const { where, params } = buildAuditLogWhere(filters)
  const row = getDb()
    .prepare(`SELECT COUNT(1) AS c ${AUDIT_LIST_FROM} ${where}`)
    .get(...params) as { c: number }
  return row.c
}

export function listAuditLogPaginated(input: ListAuditLogPaginatedInput): DbAuditWithRun[] {
  const page = Math.max(1, input.page)
  const pageSize = Math.max(1, input.pageSize)
  const offset = (page - 1) * pageSize
  const { where, params } = buildAuditLogWhere(input)
  const orderBy = input.sort === "timestamp_asc" ? "a.timestamp ASC" : "a.timestamp DESC"
  return getDb()
    .prepare(`${AUDIT_LIST_SELECT} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as DbAuditWithRun[]
}

/** Distinct users / scope_ids for filter pickers (admin audit UI). */
export function listAuditFilterOptions(): {
  users: Array<{ upn: string; role: "admin" | "operator" }>
  scopeIds: string[]
  actions: string[]
} {
  const db = getDb()
  const users = (
    db
      .prepare(
        `SELECT x.upn AS upn, COALESCE(u.is_admin, 0) AS is_admin
         FROM (
           SELECT DISTINCT upn FROM (
             SELECT upn FROM users WHERE upn != ''
             UNION
             SELECT r.upn AS upn FROM audit_log a
               INNER JOIN runs r ON r.id = a.run_id
               WHERE r.upn IS NOT NULL AND r.upn != ''
             UNION
             SELECT a.actor AS upn FROM audit_log a
               WHERE a.actor != '' AND a.actor NOT IN ('user', 'agent')
           )
         ) x
         LEFT JOIN users u ON u.upn = x.upn
         ORDER BY x.upn
         LIMIT 200`,
      )
      .all() as Array<{ upn: string; is_admin: number }>
  ).map((r) => ({
    upn: r.upn,
    role: r.is_admin === 1 ? ("admin" as const) : ("operator" as const),
  }))
  const scopeIds = (
    db
      .prepare(
        `SELECT DISTINCT scope_id AS scope_id FROM audit_log WHERE scope_id IS NOT NULL AND scope_id != '' ORDER BY scope_id LIMIT 100`,
      )
      .all() as Array<{ scope_id: string }>
  ).map((r) => r.scope_id)
  const actions = (
    db
      .prepare(`SELECT DISTINCT action FROM audit_log WHERE action != '' ORDER BY action LIMIT 300`)
      .all() as Array<{ action: string }>
  ).map((r) => r.action)
  return { users, scopeIds, actions }
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
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO checkpoints (run_id, messages, iteration, step_counter, updated_at)
    VALUES (@run_id, @messages, @iteration, @step_counter, @updated_at)
  `
    )
    .run(cp)
}

export function getCheckpoint(runId: string): DbCheckpoint | undefined {
  return getDb().prepare("SELECT * FROM checkpoints WHERE run_id = ?").get(runId) as DbCheckpoint | undefined
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
  getDb()
    .prepare(
      `
    INSERT INTO run_log (run_id, level, message, timestamp)
    VALUES (@run_id, @level, @message, @timestamp)
  `
    )
    .run(entry)
}

export function getLogs(runId: string, level?: string): DbLog[] {
  if (level) {
    return getDb()
      .prepare("SELECT * FROM run_log WHERE run_id = ? AND level = ? ORDER BY timestamp")
      .all(runId, level) as DbLog[]
  }
  return getDb().prepare("SELECT * FROM run_log WHERE run_id = ? ORDER BY timestamp").all(runId) as DbLog[]
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
  getDb()
    .prepare(
      `
    INSERT INTO trace_entries (run_id, seq, data, created_at)
    VALUES (@run_id, @seq, @data, @created_at)
  `
    )
    .run(entry)
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
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO token_usage (run_id, prompt_tokens, completion_tokens, total_tokens, llm_calls, model, created_at)
    VALUES (@run_id, @prompt_tokens, @completion_tokens, @total_tokens, @llm_calls, @model, @created_at)
  `
    )
    .run(usage)
}

export function getTokenUsage(runId: string): DbTokenUsage | undefined {
  return getDb().prepare("SELECT * FROM token_usage WHERE run_id = ?").get(runId) as DbTokenUsage | undefined
}

export function listTokenUsage(limit = 100): DbTokenUsage[] {
  return getDb()
    .prepare("SELECT * FROM token_usage ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbTokenUsage[]
}

/** Admin token-usage browser filters (join token_usage → runs). */
export interface TokenUsageFilters {
  search?: string
  user?: string
  model?: string
  from?: string
  to?: string
}

export type TokenUsageSort =
  | "created_desc"
  | "created_asc"
  | "tokens_desc"
  | "tokens_asc"

export interface ListTokenUsagePaginatedInput extends TokenUsageFilters {
  page: number
  pageSize: number
  sort?: TokenUsageSort
}

export interface DbTokenUsageWithRun extends DbTokenUsage {
  run_goal: string | null
  run_status: string | null
  run_upn: string | null
  run_display_name: string | null
  thread_id: string | null
  thread_title: string | null
}

function buildTokenUsageWhere(filters: TokenUsageFilters): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  if (filters.user?.trim()) {
    clauses.push("r.upn = ?")
    params.push(filters.user.trim())
  }
  if (filters.model?.trim()) {
    clauses.push("t.model = ?")
    params.push(filters.model.trim())
  }
  if (filters.from?.trim()) {
    const from = filters.from.trim()
    clauses.push("t.created_at >= ?")
    params.push(from.includes("T") ? from : `${from}T00:00:00`)
  }
  if (filters.to?.trim()) {
    const to = filters.to.trim()
    clauses.push("t.created_at <= ?")
    params.push(to.includes("T") ? to : `${to}T23:59:59.999`)
  }
  const search = filters.search?.trim()
  if (search) {
    const q = `%${search}%`
    clauses.push(
      `(t.run_id LIKE ? OR t.model LIKE ? OR IFNULL(r.goal, '') LIKE ? OR IFNULL(r.upn, '') LIKE ? OR IFNULL(r.display_name, '') LIKE ? OR IFNULL(th.title, '') LIKE ?)`,
    )
    params.push(q, q, q, q, q, q)
  }

  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  }
}

const TOKEN_USAGE_LIST_FROM = `
  FROM token_usage t
  INNER JOIN runs r ON r.id = t.run_id
  LEFT JOIN threads th ON th.id = r.thread_id
`

const TOKEN_USAGE_LIST_SELECT = `
  SELECT
    t.run_id, t.prompt_tokens, t.completion_tokens, t.total_tokens, t.llm_calls, t.model, t.created_at,
    r.goal AS run_goal, r.status AS run_status, r.upn AS run_upn,
    r.display_name AS run_display_name,
    r.thread_id AS thread_id, th.title AS thread_title
  ${TOKEN_USAGE_LIST_FROM}
`

function tokenUsageOrderBy(sort: TokenUsageSort | undefined): string {
  switch (sort) {
    case "created_asc":
      return "t.created_at ASC"
    case "tokens_desc":
      return "t.total_tokens DESC, t.created_at DESC"
    case "tokens_asc":
      return "t.total_tokens ASC, t.created_at DESC"
    case "created_desc":
    default:
      return "t.created_at DESC"
  }
}

export function countTokenUsage(filters: TokenUsageFilters = {}): number {
  const { where, params } = buildTokenUsageWhere(filters)
  const row = getDb()
    .prepare(`SELECT COUNT(1) AS c ${TOKEN_USAGE_LIST_FROM} ${where}`)
    .get(...params) as { c: number }
  return row.c
}

export function listTokenUsagePaginated(input: ListTokenUsagePaginatedInput): DbTokenUsageWithRun[] {
  const page = Math.max(1, input.page)
  const pageSize = Math.max(1, input.pageSize)
  const offset = (page - 1) * pageSize
  const { where, params } = buildTokenUsageWhere(input)
  const orderBy = tokenUsageOrderBy(input.sort)
  return getDb()
    .prepare(`${TOKEN_USAGE_LIST_SELECT} ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as DbTokenUsageWithRun[]
}

/** Sums for the same filter set as the usage list (KPI strip). */
export function sumTokenUsage(filters: TokenUsageFilters = {}): {
  total_prompt_tokens: number
  total_completion_tokens: number
  total_tokens: number
  total_llm_calls: number
  run_count: number
  completed_runs: number
  failed_runs: number
} {
  const { where, params } = buildTokenUsageWhere(filters)
  return getDb()
    .prepare(
      `
      SELECT
        COALESCE(SUM(t.prompt_tokens), 0) AS total_prompt_tokens,
        COALESCE(SUM(t.completion_tokens), 0) AS total_completion_tokens,
        COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(t.llm_calls), 0) AS total_llm_calls,
        COUNT(1) AS run_count,
        COALESCE(SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_runs,
        COALESCE(SUM(CASE WHEN r.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_runs
      ${TOKEN_USAGE_LIST_FROM}
      ${where}
    `,
    )
    .get(...params) as {
    total_prompt_tokens: number
    total_completion_tokens: number
    total_tokens: number
    total_llm_calls: number
    run_count: number
    completed_runs: number
    failed_runs: number
  }
}

export function listTokenUsageFilterOptions(): {
  users: Array<{ upn: string; role: "admin" | "operator" }>
  models: string[]
} {
  const db = getDb()
  const users = (
    db
      .prepare(
        `SELECT x.upn AS upn, COALESCE(u.is_admin, 0) AS is_admin
         FROM (
           SELECT DISTINCT r.upn AS upn
           FROM token_usage t
           INNER JOIN runs r ON r.id = t.run_id
           WHERE r.upn IS NOT NULL AND r.upn != ''
         ) x
         LEFT JOIN users u ON u.upn = x.upn
         ORDER BY x.upn
         LIMIT 200`,
      )
      .all() as Array<{ upn: string; is_admin: number }>
  ).map((r) => ({
    upn: r.upn,
    role: r.is_admin === 1 ? ("admin" as const) : ("operator" as const),
  }))
  const models = (
    db
      .prepare(
        `SELECT DISTINCT model FROM token_usage WHERE model != '' ORDER BY model LIMIT 100`,
      )
      .all() as Array<{ model: string }>
  ).map((r) => r.model)
  return { users, models }
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
    .prepare(
      "SELECT COALESCE(SUM(prompt_tokens),0) as total_prompt_tokens, COALESCE(SUM(completion_tokens),0) as total_completion_tokens, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(llm_calls),0) as total_llm_calls FROM token_usage"
    )
    .get() as Omit<UsageTotals, "run_count" | "completed_runs" | "failed_runs">
  const runStats = getDb()
    .prepare(
      "SELECT COUNT(*) as run_count, COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END),0) as completed_runs, COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END),0) as failed_runs FROM runs"
    )
    .get() as { run_count: number; completed_runs: number; failed_runs: number }
  return { ...tokens, ...runStats }
}

/** Usage totals for one user (operator About / personal dossier). */
export function getUsageTotalsForUser(upn: string): UsageTotals {
  if (!upn) {
    return {
      total_prompt_tokens: 0,
      total_completion_tokens: 0,
      total_tokens: 0,
      total_llm_calls: 0,
      run_count: 0,
      completed_runs: 0,
      failed_runs: 0,
    }
  }
  const tokens = getDb()
    .prepare(
      `
      SELECT
        COALESCE(SUM(t.prompt_tokens), 0) AS total_prompt_tokens,
        COALESCE(SUM(t.completion_tokens), 0) AS total_completion_tokens,
        COALESCE(SUM(t.total_tokens), 0) AS total_tokens,
        COALESCE(SUM(t.llm_calls), 0) AS total_llm_calls
      FROM runs r
      LEFT JOIN token_usage t ON t.run_id = r.id
      WHERE r.upn = ?
    `,
    )
    .get(upn) as Omit<UsageTotals, "run_count" | "completed_runs" | "failed_runs">
  const runStats = getDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS run_count,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_runs,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_runs
      FROM runs
      WHERE upn = ?
    `,
    )
    .get(upn) as { run_count: number; completed_runs: number; failed_runs: number }
  return { ...tokens, ...runStats }
}
