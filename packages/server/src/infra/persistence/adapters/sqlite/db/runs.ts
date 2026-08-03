/**
 * Run persistence — CRUD for agent runs, checkpoints, audit logs, traces.
 */

import { isRunStatus, RUN_STATUSES, RunStatus } from "@mia/agent"
import type { Run } from "@mia/shared-types"
import type { SelectQueryBuilder } from "kysely"
import { sql } from "kysely"
import { getPlatformDb } from "../../../schema/kysely.js"
import type { PlatformDatabase } from "../../../schema/tables.js"
import { runAll, runChanges, runExec, runGet } from "../../../schema/execute.js"
import { coalescePlatformNow, platformNow } from "../../../schema/sql-time.js"
import { rememberRunOwner } from "../../../../../ports/run-owner-index.js"

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

// IMPORTANT: saveRun uses INSERT … ON CONFLICT DO UPDATE, NOT `INSERT OR REPLACE`.
// With the v14 schema redesign, several child tables (trace_entries, audit_log,
// run_log, notifications, …) FK to runs(id) with `ON DELETE CASCADE`.
// `INSERT OR REPLACE` is implemented as DELETE + INSERT in SQLite, so each status
// update would silently wipe the entire trace, audit log, and stored logs for that
// run — leaving every UI widget (MIA-CHAT, IOE, StepTimeline, AgentViz, …) blank.
// ON CONFLICT DO UPDATE updates the row in place and does not fire cascade deletes.

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
  const existingCompiled = getPlatformDb()
    .selectFrom("runs")
    .select(["thread_id", "upn", "display_name"])
    .where("id", "=", run.id)
    .compile()
  const existing = runGet<{
    thread_id: string | null
    upn: string | null
    display_name: string | null
  }>(existingCompiled)

  const thread_id = run.thread_id ?? existing?.thread_id ?? null
  const upn = (run.upn ?? existing?.upn ?? null)?.trim().toLowerCase() || null
  const display_name = run.display_name ?? existing?.display_name ?? null

  const row = {
    id: run.id,
    goal: run.goal,
    status: run.status,
    answer: run.answer,
    step_count: run.step_count,
    error: run.error,
    parent_run_id: run.parent_run_id,
    created_at: run.created_at,
    completed_at: run.completed_at,
    thread_id,
    upn,
    display_name,
  }

  const compiled = getPlatformDb()
    .insertInto("runs")
    .values(row as never)
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        goal: run.goal,
        status: run.status,
        answer: run.answer,
        step_count: run.step_count,
        error: run.error,
        parent_run_id: run.parent_run_id,
        created_at: run.created_at,
        completed_at: run.completed_at,
        thread_id,
        upn: upn as never,
        display_name: display_name as never,
      })
    )
    .compile()
  runExec(compiled)
  rememberRunOwner(run.id, upn)
}

export function getRun(id: string): DbRun | undefined {
  const compiled = getPlatformDb()
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", id)
    .compile()
  return runGet<DbRun>(compiled)
}

/** True when approve/resume already spawned a child that supersedes this run. */
export function runHasResumeChild(runId: string): boolean {
  const compiled = getPlatformDb()
    .selectFrom("runs")
    .select(sql<number>`1`.as("ok"))
    .where("parent_run_id", "=", runId)
    .limit(1)
    .compile()
  return Boolean(runGet(compiled))
}

export function listRuns(limit = 100, offset = 0): DbRun[] {
  const compiled = getPlatformDb()
    .selectFrom("runs")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset)
    .compile()
  return runAll<DbRun>(compiled)
}

export interface DbRunWithUsage extends DbRun {
  total_tokens: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  llm_calls: number | null
}

function runsWithUsageQuery() {
  return getPlatformDb()
    .selectFrom("runs as r")
    .leftJoin("token_usage as t", "t.run_id", "r.id")
    .selectAll("r")
    .select([
      "t.total_tokens",
      "t.prompt_tokens",
      "t.completion_tokens",
      "t.llm_calls",
    ])
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
  const compiled = runsWithUsageQuery()
    .where("r.thread_id", "=", threadId)
    .orderBy("r.created_at", "desc")
    .limit(limit)
    .offset(offset)
    .compile()
  return runAll<DbRunWithUsage>(compiled)
}

export function listRunsWithUsage(limit = 100, offset = 0): DbRunWithUsage[] {
  const compiled = runsWithUsageQuery()
    .orderBy("r.created_at", "desc")
    .limit(limit)
    .offset(offset)
    .compile()
  return runAll<DbRunWithUsage>(compiled)
}

/** Scoped listing for authenticated visitors — upn only (no session_id fallback). */
export function listRunsWithUsageForUser(
  opts: { upn?: string | null },
  limit = 100,
  offset = 0
): DbRunWithUsage[] {
  const { upn } = opts
  if (!upn) return []
  const compiled = runsWithUsageQuery()
    .where("r.upn", "=", upn)
    .orderBy("r.created_at", "desc")
    .limit(limit)
    .offset(offset)
    .compile()
  return runAll<DbRunWithUsage>(compiled)
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
  const compiled = getPlatformDb()
    .selectFrom("runs")
    .selectAll()
    .where("status", "in", [...NON_TERMINAL_RUN_STATUSES])
    .orderBy("created_at", "desc")
    .compile()
  return runAll<DbRun>(compiled)
}

export function markRunCrashed(runId: string): void {
  const compiled = getPlatformDb()
    .updateTable("runs")
    .set({
      status: RunStatus.Crashed,
      error: "Server restarted \u2014 run interrupted",
      completed_at: platformNow(),
    })
    .where("id", "=", runId)
    .compile()
  runExec(compiled)
}

/** Boot-time hygiene: any row whose status is NOT a known RunStatus
 *  (e.g. legacy 'queued' or anything mistakenly written before the
 *  enum guard existed) gets normalised to 'failed' so the lifecycle
 *  invariants downstream code relies on remain true. */
export function normaliseUnknownRunStatuses(): number {
  const compiled = getPlatformDb()
    .updateTable("runs")
    .set({
      status: RunStatus.Failed,
      error: sql`coalesce(error, 'Unknown legacy status \u2014 normalised on boot')`,
      completed_at: coalescePlatformNow("completed_at"),
    })
    .where("status", "not in", [...RUN_STATUSES])
    .compile()
  return runChanges(compiled)
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
  const compiled = getPlatformDb()
    .updateTable("runs")
    .set({
      status: RunStatus.Cancelled,
      completed_at: coalescePlatformNow("completed_at"),
    })
    .where("id", "=", runId)
    .where("status", "in", [...NON_TERMINAL_RUN_STATUSES])
    .compile()
  runExec(compiled)
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
  const compiled = getPlatformDb()
    .insertInto("audit_log")
    .values({
      run_id: entry.run_id,
      scope_type: scopeType,
      scope_id: scopeId,
      actor: entry.actor,
      action: entry.action,
      detail: entry.detail,
      timestamp: entry.timestamp,
    })
    .compile()
  runExec(compiled)
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
  const compiled = getPlatformDb()
    .selectFrom("audit_log")
    .selectAll()
    .where("scope_type", "=", "run")
    .where("run_id", "=", runId)
    .orderBy("timestamp")
    .compile()
  return runAll<DbAudit>(compiled)
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

type AuditLogSelectQuery = SelectQueryBuilder<
  PlatformDatabase,
  "audit_log as a" | "runs as r" | "threads as t",
  object
>

function auditLogListFrom(): AuditLogSelectQuery {
  return getPlatformDb()
    .selectFrom("audit_log as a")
    .leftJoin("runs as r", "r.id", "a.run_id")
    .leftJoin("threads as t", "t.id", "r.thread_id")
}

function auditLogListSelect(): AuditLogSelectQuery {
  return auditLogListFrom().select([
    "a.id",
    "a.run_id",
    "a.scope_type",
    "a.scope_id",
    "a.actor",
    "a.action",
    "a.detail",
    "a.timestamp",
    sql<string | null>`r.goal`.as("run_goal"),
    sql<string | null>`r.status`.as("run_status"),
    sql<string | null>`r.upn`.as("run_upn"),
    sql<string | null>`r.display_name`.as("run_display_name"),
    sql<string | null>`r.thread_id`.as("thread_id"),
    sql<string | null>`t.title`.as("thread_title"),
  ])
}

function applyAuditLogFilters(
  query: AuditLogSelectQuery,
  filters: AuditLogFilters,
): AuditLogSelectQuery {
  let q = query
  if (filters.scopeType === "run" || filters.scopeType === "admin") {
    q = q.where("a.scope_type", "=", filters.scopeType)
  }
  const scopeId = filters.scopeId?.trim()
  if (scopeId) {
    q = q.where("a.scope_id", "=", scopeId)
  }
  const runId = filters.runId?.trim()
  if (runId) {
    q = q.where("a.run_id", "=", runId)
  }
  const threadId = filters.threadId?.trim()
  if (threadId) {
    q = q.where("r.thread_id", "=", threadId)
  }
  const user = filters.user?.trim()
  if (user) {
    // One identity: run owner (operator work) or admin actor UPN.
    q = q.where((eb) => eb.or([eb("r.upn", "=", user), eb("a.actor", "=", user)]))
  }
  const action = filters.action?.trim()
  if (action) {
    if (action.endsWith(".")) {
      q = q.where("a.action", "like", `${action}%`)
    } else {
      q = q.where("a.action", "=", action)
    }
  }
  const from = filters.from?.trim()
  if (from) {
    // Date-only inputs become start-of-day ISO so they compare correctly
    // against timestamps that use `T` (string compare: `T` > space).
    q = q.where("a.timestamp", ">=", from.includes("T") ? from : `${from}T00:00:00`)
  }
  const to = filters.to?.trim()
  if (to) {
    q = q.where("a.timestamp", "<=", to.includes("T") ? to : `${to}T23:59:59.999`)
  }
  const search = filters.search?.trim()
  if (search) {
    const qLike = `%${search}%`
    q = q.where((eb) =>
      eb.or([
        eb("a.action", "like", qLike),
        eb("a.actor", "like", qLike),
        eb("a.detail", "like", qLike),
        eb("a.run_id", "like", qLike),
        eb("a.scope_id", "like", qLike),
        eb(sql`IFNULL(r.goal, '')`, "like", qLike),
        eb(sql`IFNULL(r.upn, '')`, "like", qLike),
      ]),
    )
  }
  return q
}

function applyAuditLogOrder(
  query: AuditLogSelectQuery,
  sort: AuditLogSort | undefined,
): AuditLogSelectQuery {
  return sort === "timestamp_asc"
    ? query.orderBy("a.timestamp", "asc")
    : query.orderBy("a.timestamp", "desc")
}

export function countAuditLog(filters: AuditLogFilters = {}): number {
  const compiled = applyAuditLogFilters(
    auditLogListFrom().select(sql<number>`count(1)`.as("c")),
    filters,
  ).compile()
  const row = runGet<{ c: number }>(compiled)
  return row?.c ?? 0
}

export function listAuditLogPaginated(input: ListAuditLogPaginatedInput): DbAuditWithRun[] {
  const page = Math.max(1, input.page)
  const pageSize = Math.max(1, input.pageSize)
  const offset = (page - 1) * pageSize
  const compiled = applyAuditLogOrder(
    applyAuditLogFilters(auditLogListSelect(), input),
    input.sort,
  )
    .limit(pageSize)
    .offset(offset)
    .compile()
  return runAll<DbAuditWithRun>(compiled)
}

function auditFilterUserUpnUnion() {
  const fromUsers = getPlatformDb()
    .selectFrom("users")
    .select("upn")
    .where("upn", "!=", "")

  const fromRunOwners = getPlatformDb()
    .selectFrom("audit_log as a")
    .innerJoin("runs as r", "r.id", "a.run_id")
    .select(sql<string>`r.upn`.as("upn"))
    .where("r.upn", "is not", null)
    .where("r.upn", "!=", "")

  const fromActors = getPlatformDb()
    .selectFrom("audit_log as a")
    .select(sql<string>`a.actor`.as("upn"))
    .where("a.actor", "!=", "")
    .where("a.actor", "not in", ["user", "agent"])

  return fromUsers.union(fromRunOwners).union(fromActors)
}

/** Distinct users / scope_ids for filter pickers (admin audit UI). */
export function listAuditFilterOptions(): {
  users: Array<{ upn: string; role: "admin" | "operator" }>
  scopeIds: string[]
  actions: string[]
} {
  const usersCompiled = getPlatformDb()
    .selectFrom(auditFilterUserUpnUnion().as("x"))
    .leftJoin("users as u", "u.upn", "x.upn")
    .select(["x.upn as upn", sql<number>`coalesce(u.is_admin, 0)`.as("is_admin")])
    .distinct()
    .orderBy("x.upn")
    .limit(200)
    .compile()
  const users = runAll<{ upn: string; is_admin: number }>(usersCompiled).map((r) => ({
    upn: r.upn,
    role: r.is_admin === 1 ? ("admin" as const) : ("operator" as const),
  }))
  const scopeIdsCompiled = getPlatformDb()
    .selectFrom("audit_log")
    .select("scope_id")
    .where("scope_id", "is not", null)
    .where("scope_id", "!=", "")
    .distinct()
    .orderBy("scope_id")
    .limit(100)
    .compile()
  const scopeIds = runAll<{ scope_id: string }>(scopeIdsCompiled).map((r) => r.scope_id)
  const actionsCompiled = getPlatformDb()
    .selectFrom("audit_log")
    .select("action")
    .where("action", "!=", "")
    .distinct()
    .orderBy("action")
    .limit(300)
    .compile()
  const actions = runAll<{ action: string }>(actionsCompiled).map((r) => r.action)
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
  const compiled = getPlatformDb()
    .insertInto("checkpoints")
    .values({
      run_id: cp.run_id,
      messages: cp.messages,
      iteration: cp.iteration,
      step_counter: cp.step_counter,
      updated_at: cp.updated_at,
    })
    .onConflict((oc) =>
      oc.column("run_id").doUpdateSet({
        messages: cp.messages,
        iteration: cp.iteration,
        step_counter: cp.step_counter,
        updated_at: cp.updated_at,
      })
    )
    .compile()
  runExec(compiled)
}

export function getCheckpoint(runId: string): DbCheckpoint | undefined {
  const compiled = getPlatformDb()
    .selectFrom("checkpoints")
    .selectAll()
    .where("run_id", "=", runId)
    .compile()
  return runGet<DbCheckpoint>(compiled)
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
  const compiled = getPlatformDb()
    .insertInto("run_log")
    .values({
      run_id: entry.run_id,
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
    })
    .compile()
  runExec(compiled)
}

export function getLogs(runId: string, level?: string): DbLog[] {
  let query = getPlatformDb()
    .selectFrom("run_log")
    .selectAll()
    .where("run_id", "=", runId)
  if (level) {
    query = query.where("level", "=", level)
  }
  const compiled = query.orderBy("timestamp").compile()
  return runAll<DbLog>(compiled)
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
  const compiled = getPlatformDb()
    .insertInto("trace_entries")
    .values({
      run_id: entry.run_id,
      seq: entry.seq,
      data: entry.data,
      created_at: entry.created_at,
    })
    .compile()
  runExec(compiled)
}

export function getTraceEntries(runId: string): DbTraceEntry[] {
  const compiled = getPlatformDb()
    .selectFrom("trace_entries")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("seq")
    .compile()
  return runAll<DbTraceEntry>(compiled)
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
  const compiled = getPlatformDb()
    .insertInto("token_usage")
    .values({
      run_id: usage.run_id,
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
      llm_calls: usage.llm_calls,
      model: usage.model,
      created_at: usage.created_at,
    })
    .onConflict((oc) =>
      oc.column("run_id").doUpdateSet({
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        llm_calls: usage.llm_calls,
        model: usage.model,
        created_at: usage.created_at,
      })
    )
    .compile()
  runExec(compiled)
}

export function getTokenUsage(runId: string): DbTokenUsage | undefined {
  const compiled = getPlatformDb()
    .selectFrom("token_usage")
    .selectAll()
    .where("run_id", "=", runId)
    .compile()
  return runGet<DbTokenUsage>(compiled)
}

export function listTokenUsage(limit = 100): DbTokenUsage[] {
  const compiled = getPlatformDb()
    .selectFrom("token_usage")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(limit)
    .compile()
  return runAll<DbTokenUsage>(compiled)
}

/** Admin token-usage browser filters (join token_usage → runs). */
export interface TokenUsageFilters {
  search?: string
  user?: string
  model?: string
  /** Multi-select run statuses (OR). */
  status?: string[]
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

type TokenUsageSelectQuery = SelectQueryBuilder<
  PlatformDatabase,
  "token_usage as t" | "runs as r" | "threads as th",
  object
>

function tokenUsageListFrom(): TokenUsageSelectQuery {
  return getPlatformDb()
    .selectFrom("token_usage as t")
    .innerJoin("runs as r", "r.id", "t.run_id")
    .leftJoin("threads as th", "th.id", "r.thread_id")
}

function tokenUsageListSelect(): TokenUsageSelectQuery {
  return tokenUsageListFrom().select([
    "t.run_id",
    "t.prompt_tokens",
    "t.completion_tokens",
    "t.total_tokens",
    "t.llm_calls",
    "t.model",
    "t.created_at",
    sql<string | null>`r.goal`.as("run_goal"),
    sql<string | null>`r.status`.as("run_status"),
    sql<string | null>`r.upn`.as("run_upn"),
    sql<string | null>`r.display_name`.as("run_display_name"),
    sql<string | null>`r.thread_id`.as("thread_id"),
    sql<string | null>`th.title`.as("thread_title"),
  ])
}

function applyTokenUsageFilters(
  query: TokenUsageSelectQuery,
  filters: TokenUsageFilters,
): TokenUsageSelectQuery {
  let q = query
  const user = filters.user?.trim()
  if (user) {
    q = q.where("r.upn", "=", user)
  }
  const model = filters.model?.trim()
  if (model) {
    q = q.where("t.model", "=", model)
  }
  if (filters.status && filters.status.length > 0) {
    const statuses = filters.status.map((s) => s.trim()).filter(Boolean)
    if (statuses.length === 1) {
      q = q.where("r.status", "=", statuses[0]!)
    } else if (statuses.length > 1) {
      q = q.where("r.status", "in", statuses)
    }
  }
  const from = filters.from?.trim()
  if (from) {
    q = q.where("t.created_at", ">=", from.includes("T") ? from : `${from}T00:00:00`)
  }
  const to = filters.to?.trim()
  if (to) {
    q = q.where("t.created_at", "<=", to.includes("T") ? to : `${to}T23:59:59.999`)
  }
  const search = filters.search?.trim()
  if (search) {
    const qLike = `%${search}%`
    q = q.where((eb) =>
      eb.or([
        eb("t.run_id", "like", qLike),
        eb("t.model", "like", qLike),
        eb(sql`IFNULL(r.goal, '')`, "like", qLike),
        eb(sql`IFNULL(r.upn, '')`, "like", qLike),
        eb(sql`IFNULL(r.display_name, '')`, "like", qLike),
        eb(sql`IFNULL(th.title, '')`, "like", qLike),
      ]),
    )
  }
  return q
}

function applyTokenUsageOrder(
  query: TokenUsageSelectQuery,
  sort: TokenUsageSort | undefined,
): TokenUsageSelectQuery {
  switch (sort) {
    case "created_asc":
      return query.orderBy("t.created_at", "asc")
    case "tokens_desc":
      return query.orderBy("t.total_tokens", "desc").orderBy("t.created_at", "desc")
    case "tokens_asc":
      return query.orderBy("t.total_tokens", "asc").orderBy("t.created_at", "desc")
    case "created_desc":
    default:
      return query.orderBy("t.created_at", "desc")
  }
}

export function countTokenUsage(filters: TokenUsageFilters = {}): number {
  const compiled = applyTokenUsageFilters(
    tokenUsageListFrom().select(sql<number>`count(1)`.as("c")),
    filters,
  ).compile()
  const row = runGet<{ c: number }>(compiled)
  return row?.c ?? 0
}

export function listTokenUsagePaginated(input: ListTokenUsagePaginatedInput): DbTokenUsageWithRun[] {
  const page = Math.max(1, input.page)
  const pageSize = Math.max(1, input.pageSize)
  const offset = (page - 1) * pageSize
  const compiled = applyTokenUsageOrder(
    applyTokenUsageFilters(tokenUsageListSelect(), input),
    input.sort,
  )
    .limit(pageSize)
    .offset(offset)
    .compile()
  return runAll<DbTokenUsageWithRun>(compiled)
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
  cancelled_runs: number
  crashed_runs: number
  running_runs: number
} {
  const compiled = applyTokenUsageFilters(
    tokenUsageListFrom().select([
      sql<number>`coalesce(sum(t.prompt_tokens), 0)`.as("total_prompt_tokens"),
      sql<number>`coalesce(sum(t.completion_tokens), 0)`.as("total_completion_tokens"),
      sql<number>`coalesce(sum(t.total_tokens), 0)`.as("total_tokens"),
      sql<number>`coalesce(sum(t.llm_calls), 0)`.as("total_llm_calls"),
      sql<number>`count(1)`.as("run_count"),
      sql<number>`coalesce(sum(case when r.status = 'completed' then 1 else 0 end), 0)`.as(
        "completed_runs",
      ),
      sql<number>`coalesce(sum(case when r.status = 'failed' then 1 else 0 end), 0)`.as(
        "failed_runs",
      ),
      sql<number>`coalesce(sum(case when r.status = 'cancelled' then 1 else 0 end), 0)`.as(
        "cancelled_runs",
      ),
      sql<number>`coalesce(sum(case when r.status = 'crashed' then 1 else 0 end), 0)`.as(
        "crashed_runs",
      ),
      sql<number>`coalesce(sum(case when r.status = 'running' then 1 else 0 end), 0)`.as(
        "running_runs",
      ),
    ]),
    filters,
  ).compile()
  return runGet(compiled)!
}

export function listTokenUsageFilterOptions(): {
  users: Array<{ upn: string; role: "admin" | "operator" }>
  models: string[]
} {
  const usersCompiled = getPlatformDb()
    .selectFrom(
      getPlatformDb()
        .selectFrom("token_usage as t")
        .innerJoin("runs as r", "r.id", "t.run_id")
        .select(sql<string>`r.upn`.as("upn"))
        .where("r.upn", "is not", null)
        .where("r.upn", "!=", "")
        .distinct()
        .as("x"),
    )
    .leftJoin("users as u", "u.upn", "x.upn")
    .select(["x.upn as upn", sql<number>`coalesce(u.is_admin, 0)`.as("is_admin")])
    .orderBy("x.upn")
    .limit(200)
    .compile()
  const users = runAll<{ upn: string; is_admin: number }>(usersCompiled).map((r) => ({
    upn: r.upn,
    role: r.is_admin === 1 ? ("admin" as const) : ("operator" as const),
  }))
  const modelsCompiled = getPlatformDb()
    .selectFrom("token_usage")
    .select("model")
    .where("model", "!=", "")
    .distinct()
    .orderBy("model")
    .limit(100)
    .compile()
  const models = runAll<{ model: string }>(modelsCompiled).map((r) => r.model)
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
  const tokensCompiled = getPlatformDb()
    .selectFrom("token_usage")
    .select([
      sql<number>`coalesce(sum(prompt_tokens), 0)`.as("total_prompt_tokens"),
      sql<number>`coalesce(sum(completion_tokens), 0)`.as("total_completion_tokens"),
      sql<number>`coalesce(sum(total_tokens), 0)`.as("total_tokens"),
      sql<number>`coalesce(sum(llm_calls), 0)`.as("total_llm_calls"),
    ])
    .compile()
  const tokens = runGet<Omit<UsageTotals, "run_count" | "completed_runs" | "failed_runs">>(
    tokensCompiled
  )!
  const runStatsCompiled = getPlatformDb()
    .selectFrom("runs")
    .select([
      sql<number>`count(*)`.as("run_count"),
      sql<number>`coalesce(sum(case when status = 'completed' then 1 else 0 end), 0)`.as(
        "completed_runs"
      ),
      sql<number>`coalesce(sum(case when status = 'failed' then 1 else 0 end), 0)`.as(
        "failed_runs"
      ),
    ])
    .compile()
  const runStats = runGet<{ run_count: number; completed_runs: number; failed_runs: number }>(
    runStatsCompiled
  )!
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
  const tokensCompiled = getPlatformDb()
    .selectFrom("runs as r")
    .leftJoin("token_usage as t", "t.run_id", "r.id")
    .select([
      sql<number>`coalesce(sum(t.prompt_tokens), 0)`.as("total_prompt_tokens"),
      sql<number>`coalesce(sum(t.completion_tokens), 0)`.as("total_completion_tokens"),
      sql<number>`coalesce(sum(t.total_tokens), 0)`.as("total_tokens"),
      sql<number>`coalesce(sum(t.llm_calls), 0)`.as("total_llm_calls"),
    ])
    .where("r.upn", "=", upn)
    .compile()
  const tokens = runGet<Omit<UsageTotals, "run_count" | "completed_runs" | "failed_runs">>(
    tokensCompiled
  )!
  const runStatsCompiled = getPlatformDb()
    .selectFrom("runs")
    .select([
      sql<number>`count(*)`.as("run_count"),
      sql<number>`coalesce(sum(case when status = 'completed' then 1 else 0 end), 0)`.as(
        "completed_runs"
      ),
      sql<number>`coalesce(sum(case when status = 'failed' then 1 else 0 end), 0)`.as(
        "failed_runs"
      ),
    ])
    .where("upn", "=", upn)
    .compile()
  const runStats = runGet<{ run_count: number; completed_runs: number; failed_runs: number }>(
    runStatsCompiled
  )!
  return { ...tokens, ...runStats }
}

export interface RunSummaryRow {
  id: string
  goal: string
  status: string
  step_count: number
  created_at: string
  upn: string | null
  display_name: string | null
}

export function listRunSummariesByIds(ids: readonly string[]): RunSummaryRow[] {
  if (ids.length === 0) return []
  const compiled = getPlatformDb()
    .selectFrom("runs")
    .select(["id", "goal", "status", "step_count", "created_at", "upn", "display_name"])
    .where("id", "in", [...ids])
    .orderBy("created_at", "desc")
    .compile()
  return runAll<RunSummaryRow>(compiled)
}

export function countActiveRunsByUpn(ids: readonly string[]): Array<{ upn: string; n: number }> {
  if (ids.length === 0) return []
  const compiled = getPlatformDb()
    .selectFrom("runs")
    .select([sql<string>`lower(upn)`.as("upn"), sql<number>`count(*)`.as("n")])
    .where("id", "in", [...ids])
    .groupBy(sql`lower(upn)`)
    .compile()
  return runAll<{ upn: string; n: number }>(compiled)
}

export interface PriorTurnRow {
  id: string
  goal: string
  status: string
  answer: string | null
  created_at: string
  completed_at: string | null
}

export function listPriorTurnRows(input: {
  threadId: string
  upn: string
  excludeRunId?: string | null
  limit: number
}): PriorTurnRow[] {
  let query = getPlatformDb()
    .selectFrom("runs")
    .select(["id", "goal", "status", "answer", "created_at", "completed_at"])
    .where("thread_id", "=", input.threadId)
    .where("upn", "=", input.upn)
    .where("parent_run_id", "is", null)
    .where("status", "in", ["completed", "failed"])
  if (input.excludeRunId) {
    query = query.where("id", "!=", input.excludeRunId)
  }
  const compiled = query
    .orderBy(sql`coalesce(completed_at, created_at)`, "desc")
    .limit(input.limit)
    .compile()
  return runAll<PriorTurnRow>(compiled)
}
