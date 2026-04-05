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

const DATA_DIR = process.env["AGENT001_DATA_DIR"] || join(homedir(), ".agent001")
mkdirSync(DATA_DIR, { recursive: true })

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(join(DATA_DIR, "agent001.db"))
    _db.pragma("journal_mode = WAL")
    _db.pragma("foreign_keys = ON")
    _migrate(_db)
  }
  return _db
}

/** @internal — for testing only. Swap the backing database. */
export function _setDb(db: Database.Database): void {
  _db = db
}

// ── Current seed data (bump SEED_VERSION when changing) ──────

const SEED_VERSION = 6

const DEFAULT_AGENT_PROMPT = [
  "You are an efficient AI agent that uses tools to accomplish goals.",
  "",
  "Principles:",
  "- Briefly state your approach before acting so the user can follow your reasoning.",
  "- Act directly. For simple tasks, use the right tool immediately.",
  "- NEVER browse directories one-by-one. Use run_command with find, grep, wc, etc. A single shell pipeline replaces dozens of tool calls.",
  "- For data collection tasks (counting lines, searching files, aggregating stats): write and execute ONE shell command or script. Never do it file-by-file.",
  "- Call multiple tools in one turn when operations are independent.",
  "- Don't verify results unless there's a reason to doubt them.",
  "- If a path doesn't exist, check the error message — it often tells you what does exist nearby.",
  "- You CAN access the internet. Use fetch_url to read any web page or API. For interactive web tasks (clicking buttons, filling forms, navigating multi-page flows, handling cookie consents), use browse_web which gives you a persistent browser session.",
  "- When you need information from the user (credentials, personal details, choices, confirmation), use ask_user. The agent pauses until the user responds. For things only the user can do in a browser (CAPTCHA, payment, 2FA), open a visible browser with browse_web(visible=true) and use ask_user to tell the user what to do.",
  "- After creating or modifying web projects (HTML/JS/CSS), use browser_check to verify the page loads without errors.",
  "",
  "Provide a concise final answer when done.",
].join("\n")

const DEFAULT_TOOLS = ["read_file", "write_file", "list_directory", "run_command", "fetch_url", "browser_check", "browse_web", "ask_user", "query_mssql", "explore_mssql_schema"]

/** @internal — exported for testing. */
export function _migrate(db: Database.Database): void {
  // ── Schema version tracking ────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  const getMetaValue = (key: string): string | undefined => {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as { value: string } | undefined
    return row?.value
  }
  const setMetaValue = (key: string, value: string): void => {
    db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(key, value)
  }

  // ── Tables ─────────────────────────────────────────────────
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

  // ── Column migrations ──────────────────────────────────────
  // Only suppress "duplicate column" errors, re-throw anything else
  const addColumnIfMissing = (sql: string): void => {
    try {
      db.exec(sql)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("duplicate column")) throw err
    }
  }
  addColumnIfMissing("ALTER TABLE runs ADD COLUMN agent_id TEXT")

  // ── Seed default agent (version-aware) ─────────────────────
  // Insert only on first install. Updates happen via version check below.
  db.prepare(`
    INSERT OR IGNORE INTO agent_definitions (id, name, description, system_prompt, tools, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    "default",
    "Universal Agent",
    "General-purpose agent with all tools. Handles any task.",
    DEFAULT_AGENT_PROMPT,
    JSON.stringify(DEFAULT_TOOLS),
  )

  // ── Seed default policies ──────────────────────────────────
  const seedPolicies: { name: string; effect: string; condition: string; parameters: string }[] = [
    { name: "Tool Permission", effect: "allow", condition: "tool_call", parameters: JSON.stringify({ scope: "all_tools", description: "Controls which tools agents are permitted to invoke" }) },
    { name: "Model", effect: "allow", condition: "model_selection", parameters: JSON.stringify({ scope: "all_models", description: "Controls model selection and usage limits" }) },
    { name: "Security", effect: "require_approval", condition: "sensitive_action", parameters: JSON.stringify({ scope: "destructive_ops", description: "Requires approval for destructive or sensitive operations" }) },
  ]
  const insertPolicy = db.prepare(`
    INSERT OR IGNORE INTO policy_rules (name, effect, condition, parameters, created_at)
    VALUES (@name, @effect, @condition, @parameters, datetime('now'))
  `)
  for (const p of seedPolicies) insertPolicy.run(p)

  // ── Version-based seed update ──────────────────────────────
  // When SEED_VERSION bumps, update the default agent's prompt and tools
  // ONLY if the user hasn't customized them (i.e. they still match a known old version).
  const currentSeedVersion = Number(getMetaValue("seed_version") ?? "0")
  if (currentSeedVersion < SEED_VERSION) {
    const existing = db.prepare(
      "SELECT system_prompt, tools FROM agent_definitions WHERE id = 'default'"
    ).get() as { system_prompt: string; tools: string } | undefined

    if (existing) {
      // Check if the user has customized the agent — if so, don't overwrite
      const isUserCustomized = !isKnownOldSeedPrompt(existing.system_prompt)
      if (!isUserCustomized) {
        db.prepare(
          "UPDATE agent_definitions SET system_prompt = ?, tools = ?, updated_at = datetime('now') WHERE id = 'default'"
        ).run(DEFAULT_AGENT_PROMPT, JSON.stringify(DEFAULT_TOOLS))
      }
    }

    setMetaValue("seed_version", String(SEED_VERSION))
  }
}

/**
 * Returns true if the prompt matches any known previous default prompt,
 * meaning it's safe to auto-update. If the user wrote their own custom
 * prompt, this returns false and we leave it alone.
 */
function isKnownOldSeedPrompt(prompt: string): boolean {
  // v0: original verbose prompt
  if (prompt.includes("Break it down into steps")) return true
  // v1: efficient prompt (current DEFAULT_AGENT_PROMPT is v2)
  if (prompt.includes("You are an efficient AI agent that uses tools")) return true
  return false
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

export function getLayout(id: string): DbLayout | undefined {
  return getDb()
    .prepare("SELECT * FROM layouts WHERE id = ?")
    .get(id) as DbLayout | undefined
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
    DELETE FROM notifications;
    DELETE FROM effects;
    DELETE FROM file_snapshots;
  `)
  // Also clear api_requests if the table exists
  try { db.exec("DELETE FROM api_requests") } catch { /* table may not exist yet */ }
}

// ── LLM config ───────────────────────────────────────────────────

export type LlmProvider = "copilot-chat" | "copilot" | "openai" | "anthropic" | "local"

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

// ── Stale run recovery ──────────────────────────────────────────

/**
 * Find runs that were "running" or "pending" when the server crashed.
 * These are runs that exist in the DB as active but are not in the
 * in-memory active runs map — stale from a previous server process.
 */
export function findStaleRuns(): DbRun[] {
  return getDb()
    .prepare("SELECT * FROM runs WHERE status IN ('running', 'pending', 'planning') ORDER BY created_at DESC")
    .all() as DbRun[]
}

/**
 * Mark a run as failed due to server crash (for auto-recovery flow).
 */
export function markRunCrashed(runId: string): void {
  getDb().prepare(
    "UPDATE runs SET status = 'failed', error = 'Server restarted — run interrupted', completed_at = datetime('now') WHERE id = ?"
  ).run(runId)
}

// ── Notifications ────────────────────────────────────────────────

export interface DbNotification {
  id: string
  type: string        // 'run.failed' | 'run.completed' | 'approval.required' | 'run.recovered'
  title: string
  message: string
  run_id: string | null
  step_id: string | null
  actions: string     // JSON array of { label, action, data }
  read: number        // 0 or 1
  created_at: string
}

export function migrateNotifications(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      run_id TEXT,
      step_id TEXT,
      actions TEXT NOT NULL DEFAULT '[]',
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(read, created_at DESC);
  `)
}

export function saveNotification(n: DbNotification): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO notifications (id, type, title, message, run_id, step_id, actions, read, created_at)
    VALUES (@id, @type, @title, @message, @run_id, @step_id, @actions, @read, @created_at)
  `).run(n)
}

export function listNotifications(limit = 50): DbNotification[] {
  return getDb()
    .prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbNotification[]
}

export function markNotificationRead(id: string): void {
  getDb().prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id)
}

export function markAllNotificationsRead(): void {
  getDb().prepare("UPDATE notifications SET read = 1 WHERE read = 0").run()
}

export function getUnreadNotificationCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) as count FROM notifications WHERE read = 0").get() as { count: number }
  return row.count
}

// ── API request log ──────────────────────────────────────────────

export function migrateApiRequests(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS api_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      duration_ms REAL NOT NULL,
      request_body TEXT,
      response_summary TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_requests_time ON api_requests(created_at DESC);
  `)
}

export interface DbApiRequest {
  id?: number
  method: string
  url: string
  status_code: number
  duration_ms: number
  request_body: string | null
  response_summary: string | null
  created_at: string
}

export function saveApiRequest(entry: Omit<DbApiRequest, "id">): void {
  getDb().prepare(`
    INSERT INTO api_requests (method, url, status_code, duration_ms, request_body, response_summary, created_at)
    VALUES (@method, @url, @status_code, @duration_ms, @request_body, @response_summary, @created_at)
  `).run(entry)
}

export function listApiRequests(limit = 200): DbApiRequest[] {
  return getDb()
    .prepare("SELECT * FROM api_requests ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbApiRequest[]
}

// ── Data lifecycle / pruning ─────────────────────────────────────

/**
 * Prune old data to keep the SQLite database from growing unbounded.
 *
 * Default retention: keeps the most recent `keepRuns` completed/failed runs
 * and their associated data. Running/pending runs are never pruned.
 * Also caps logs, api_requests, and notifications independently.
 */
export function pruneOldData(opts?: {
  keepRuns?: number
  keepApiRequests?: number
  keepNotifications?: number
  keepEvents?: number
}): { prunedRuns: number; prunedApiRequests: number; prunedNotifications: number; prunedEvents: number; vacuumed: boolean } {
  const db = getDb()
  const keepRuns = opts?.keepRuns ?? 500
  const keepApiRequests = opts?.keepApiRequests ?? 10_000
  const keepNotifications = opts?.keepNotifications ?? 1000
  const keepEvents = opts?.keepEvents ?? 50_000

  // Find run IDs to prune (oldest completed/failed beyond retention limit)
  const runsToPrune = db.prepare(`
    SELECT id FROM runs
    WHERE status IN ('completed', 'failed', 'cancelled')
    ORDER BY created_at DESC
    LIMIT -1 OFFSET ?
  `).all(keepRuns) as { id: string }[]

  let prunedRuns = 0
  if (runsToPrune.length > 0) {
    const ids = runsToPrune.map((r) => r.id)
    const placeholders = ids.map(() => "?").join(",")

    db.prepare(`DELETE FROM trace_entries WHERE run_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM audit_log WHERE run_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM logs WHERE run_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM token_usage WHERE run_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM checkpoints WHERE run_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM file_snapshots WHERE run_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM effects WHERE run_id IN (${placeholders})`).run(...ids)
    db.prepare(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...ids)
    prunedRuns = ids.length
  }

  // Cap api_requests
  const apiResult = db.prepare(`
    DELETE FROM api_requests WHERE id NOT IN (
      SELECT id FROM api_requests ORDER BY created_at DESC LIMIT ?
    )
  `).run(keepApiRequests)
  const prunedApiRequests = apiResult.changes

  // Cap notifications
  const notifResult = db.prepare(`
    DELETE FROM notifications WHERE id NOT IN (
      SELECT id FROM notifications ORDER BY created_at DESC LIMIT ?
    )
  `).run(keepNotifications)
  const prunedNotifications = notifResult.changes

  // Cap event_log
  let prunedEvents = 0
  try {
    const evtResult = db.prepare(`
      DELETE FROM event_log WHERE id NOT IN (
        SELECT id FROM event_log ORDER BY created_at DESC LIMIT ?
      )
    `).run(keepEvents)
    prunedEvents = evtResult.changes
  } catch { /* table may not exist yet */ }

  // Vacuum if we deleted a meaningful amount
  let vacuumed = false
  if (prunedRuns > 50 || prunedApiRequests > 1000 || prunedEvents > 5000) {
    db.pragma("wal_checkpoint(TRUNCATE)")
    vacuumed = true
  }

  return { prunedRuns, prunedApiRequests, prunedNotifications, prunedEvents, vacuumed }
}

/**
 * Get DB size and row counts for monitoring.
 */
export function getDbStats(): Record<string, number> {
  const db = getDb()
  const tables = ["runs", "audit_log", "logs", "trace_entries", "token_usage", "checkpoints",
    "effects", "file_snapshots", "notifications", "api_requests", "event_log", "webhook_drains"] as const
  const stats: Record<string, number> = {}
  for (const t of tables) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as count FROM ${t}`).get() as { count: number }
      stats[t] = row.count
    } catch {
      stats[t] = -1 // table doesn't exist yet
    }
  }
  // DB file size — page_count * page_size
  const pageCount = (db.pragma("page_count") as { page_count: number }[])[0]?.page_count ?? 0
  const pageSize = (db.pragma("page_size") as { page_size: number }[])[0]?.page_size ?? 4096
  stats["db_size_bytes"] = pageCount * pageSize
  return stats
}

// ── Unified event log ────────────────────────────────────────────

export function migrateEventLog(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS event_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_log_time ON event_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_event_log_type ON event_log(type);
  `)
}

export interface DbEvent {
  id: number
  type: string
  data: string
  created_at: string
}

export function saveEvent(type: string, data: Record<string, unknown>, timestamp: string): void {
  getDb().prepare(`
    INSERT INTO event_log (type, data, created_at)
    VALUES (?, ?, ?)
  `).run(type, JSON.stringify(data), timestamp)
}

export function listEvents(opts?: {
  limit?: number
  before?: string
  after?: string
  types?: string[]
}): DbEvent[] {
  const limit = opts?.limit ?? 200
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts?.before) {
    conditions.push("created_at < ?")
    params.push(opts.before)
  }
  if (opts?.after) {
    conditions.push("created_at > ?")
    params.push(opts.after)
  }
  if (opts?.types && opts.types.length > 0) {
    conditions.push(`type IN (${opts.types.map(() => "?").join(",")})`)
    params.push(...opts.types)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  params.push(limit)

  return getDb()
    .prepare(`SELECT * FROM event_log ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as DbEvent[]
}

// ── Webhook drains ───────────────────────────────────────────────

export function migrateWebhookDrains(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS webhook_drains (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      secret TEXT NOT NULL DEFAULT '',
      event_filters TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

export interface DbWebhookDrain {
  id: string
  url: string
  secret: string
  event_filters: string   // JSON array of type prefixes, e.g. ["run.", "audit"]
  enabled: number         // 0 or 1
  created_at: string
  updated_at: string
}

export function listWebhookDrains(): DbWebhookDrain[] {
  return getDb()
    .prepare("SELECT * FROM webhook_drains ORDER BY created_at")
    .all() as DbWebhookDrain[]
}

export function getWebhookDrain(id: string): DbWebhookDrain | undefined {
  return getDb()
    .prepare("SELECT * FROM webhook_drains WHERE id = ?")
    .get(id) as DbWebhookDrain | undefined
}

export function saveWebhookDrain(drain: DbWebhookDrain): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO webhook_drains (id, url, secret, event_filters, enabled, created_at, updated_at)
    VALUES (@id, @url, @secret, @event_filters, @enabled, @created_at, @updated_at)
  `).run(drain)
}

export function deleteWebhookDrain(id: string): void {
  getDb().prepare("DELETE FROM webhook_drains WHERE id = ?").run(id)
}
