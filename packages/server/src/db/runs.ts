/**
 * Run persistence — CRUD for agent runs, checkpoints, audit logs, traces.
 */

import { getDb } from "./connection.js"

// ── Run queries ──────────────────────────────────────────────────

export interface DbRun {
  id: string
  goal: string
  status: string
  answer: string | null
  step_count: number
  error: string | null
  parent_run_id: string | null
  agent_id: string | null
  data: string
  created_at: string
  completed_at: string | null
}

const upsertRun = () => getDb().prepare(`
  INSERT OR REPLACE INTO runs (id, goal, status, answer, step_count, error, parent_run_id, agent_id, data, created_at, completed_at)
  VALUES (@id, @goal, @status, @answer, @step_count, @error, @parent_run_id, @agent_id, @data, @created_at, @completed_at)
`)

export function saveRun(run: DbRun): void {
  upsertRun().run(run)
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

export function findStaleRuns(): DbRun[] {
  return getDb()
    .prepare("SELECT * FROM runs WHERE status IN ('running', 'pending', 'planning') ORDER BY created_at DESC")
    .all() as DbRun[]
}

export function markRunCrashed(runId: string): void {
  getDb().prepare(
    "UPDATE runs SET status = 'failed', error = 'Server restarted — run interrupted', completed_at = datetime('now') WHERE id = ?"
  ).run(runId)
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
