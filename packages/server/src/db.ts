/**
 * SQLite persistence layer.
 *
 * Stores runs, audit logs, checkpoints (for resume), and dashboard layouts.
 * Data lives in ~/.agent001/agent001.db — survives server restarts.
 */

import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DATA_DIR = join(homedir(), ".agent001")
mkdirSync(DATA_DIR, { recursive: true })

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(join(DATA_DIR, "agent001.db"))
    _db.pragma("journal_mode = WAL")
    _db.pragma("foreign_keys = ON")
    migrate(_db)
  }
  return _db
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      goal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      answer TEXT,
      step_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      parent_run_id TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints (
      run_id TEXT PRIMARY KEY,
      messages TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      step_counter INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS layouts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id);
    CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id);

    CREATE TABLE IF NOT EXISTS policy_rules (
      name TEXT PRIMARY KEY,
      effect TEXT NOT NULL,
      condition TEXT NOT NULL,
      parameters TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      run_id TEXT PRIMARY KEY,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      llm_calls INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT 'gpt-4o',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trace_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trace_run ON trace_entries(run_id, seq);

    CREATE TABLE IF NOT EXISTS llm_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL DEFAULT 'copilot',
      model TEXT NOT NULL DEFAULT 'gpt-4o',
      api_key TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO llm_config (id, provider, model, api_key, base_url, updated_at)
    VALUES (1, 'copilot', 'gpt-4o', '', '', datetime('now'));

    CREATE TABLE IF NOT EXISTS agent_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL,
      tools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // ── Column migrations (idempotent) ─────────────────────────
  try { db.exec("ALTER TABLE runs ADD COLUMN agent_id TEXT") } catch { /* already exists */ }

  // ── Seed data ──────────────────────────────────────────────
  db.prepare(`
    INSERT OR IGNORE INTO agent_definitions (id, name, description, system_prompt, tools, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    "default",
    "Universal Agent",
    "General-purpose agent with all tools. Handles any task.",
    [
      "You are a capable AI agent that can use tools to accomplish goals.",
      "",
      "When given a goal:",
      "1. Break it down into steps",
      "2. Use tools to gather information or take actions",
      "3. Observe the results and decide what to do next",
      "4. Repeat until the goal is achieved",
      "5. Provide a clear final answer",
      "",
      "Be methodical. Think before acting. If a tool call fails, try a different approach.",
      "Always explain your reasoning when providing the final answer.",
    ].join("\n"),
    JSON.stringify(["read_file", "write_file", "list_directory", "run_command", "fetch_url", "think"]),
  )
}

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

// ── Layout queries ───────────────────────────────────────────────

export interface DbLayout {
  id: string
  name: string
  config: string
  updated_at: string
}

export function saveLayout(layout: DbLayout): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO layouts (id, name, config, updated_at)
    VALUES (@id, @name, @config, @updated_at)
  `).run(layout)
}

export function getLayouts(): DbLayout[] {
  return getDb()
    .prepare("SELECT * FROM layouts ORDER BY updated_at DESC")
    .all() as DbLayout[]
}

export function deleteLayout(id: string): void {
  getDb().prepare("DELETE FROM layouts WHERE id = ?").run(id)
}

// ── Policy rule queries ──────────────────────────────────────────

export interface DbPolicyRule {
  name: string
  effect: string
  condition: string
  parameters: string
  created_at: string
}

export function listPolicyRules(): DbPolicyRule[] {
  return getDb()
    .prepare("SELECT * FROM policy_rules ORDER BY created_at")
    .all() as DbPolicyRule[]
}

export function savePolicyRule(rule: DbPolicyRule): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO policy_rules (name, effect, condition, parameters, created_at)
    VALUES (@name, @effect, @condition, @parameters, @created_at)
  `).run(rule)
}

export function deletePolicyRule(name: string): void {
  getDb().prepare("DELETE FROM policy_rules WHERE name = ?").run(name)
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
}

export function getUsageTotals(): UsageTotals {
  return getDb()
    .prepare("SELECT COALESCE(SUM(prompt_tokens),0) as total_prompt_tokens, COALESCE(SUM(completion_tokens),0) as total_completion_tokens, COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(llm_calls),0) as total_llm_calls, COUNT(*) as run_count FROM token_usage")
    .get() as UsageTotals
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

// ── Data reset (preserve policies + layouts) ─────────────────────

export function clearTransactionalData(): void {
  const db = getDb()
  db.exec(`
    DELETE FROM runs;
    DELETE FROM audit_log;
    DELETE FROM checkpoints;
    DELETE FROM logs;
    DELETE FROM token_usage;
    DELETE FROM trace_entries;
  `)
}

// ── LLM config ───────────────────────────────────────────────────

export type LlmProvider = "copilot" | "openai" | "anthropic" | "local"

export interface DbLlmConfig {
  provider: LlmProvider
  model: string
  api_key: string
  base_url: string
  updated_at: string
}

export function getLlmConfig(): DbLlmConfig {
  return getDb()
    .prepare("SELECT provider, model, api_key, base_url, updated_at FROM llm_config WHERE id = 1")
    .get() as DbLlmConfig
}

export function saveLlmConfig(cfg: Omit<DbLlmConfig, "updated_at">): void {
  getDb().prepare(`
    UPDATE llm_config
    SET provider = @provider, model = @model, api_key = @api_key,
        base_url = @base_url, updated_at = datetime('now')
    WHERE id = 1
  `).run(cfg)
}

// ── Agent definition queries ─────────────────────────────────────

export interface DbAgentDefinition {
  id: string
  name: string
  description: string
  system_prompt: string
  tools: string          // JSON array of tool names
  created_at: string
  updated_at: string
}

export function listAgentDefinitions(): DbAgentDefinition[] {
  return getDb()
    .prepare("SELECT * FROM agent_definitions ORDER BY created_at")
    .all() as DbAgentDefinition[]
}

export function getAgentDefinition(id: string): DbAgentDefinition | undefined {
  return getDb()
    .prepare("SELECT * FROM agent_definitions WHERE id = ?")
    .get(id) as DbAgentDefinition | undefined
}

export function saveAgentDefinition(agent: DbAgentDefinition): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO agent_definitions (id, name, description, system_prompt, tools, created_at, updated_at)
    VALUES (@id, @name, @description, @system_prompt, @tools, @created_at, datetime('now'))
  `).run(agent)
}

export function deleteAgentDefinition(id: string): void {
  getDb().prepare("DELETE FROM agent_definitions WHERE id = ?").run(id)
}
