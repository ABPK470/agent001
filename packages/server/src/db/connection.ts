/**
 * Database connection — singleton SQLite instance.
 *
 * All domain-specific persistence modules import getDb() from here.
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

const SEED_VERSION = 7

const DEFAULT_AGENT_PROMPT = [
  "You are an efficient AI agent that uses tools to accomplish goals.",
  "",
  "Task execution protocol:",
  "1. Start executing immediately — use the right tool in your first turn.",
  "2. If a brief preamble helps, keep it to one sentence and continue into tool use in the same turn.",
  "3. NEVER end the turn with only a plan when execution was requested.",
  "4. If a command fails (build error, test failure, etc), read the error, fix the code, and retry — do NOT stop and report the error as a blocker.",
  "5. Keep iterating until the task succeeds or you have genuinely exhausted options.",
  "6. Finish with grounded results or a specific blocker backed by tool evidence.",
  "7. NEVER run interactive programs (games, TUI apps, editors, REPLs) via run_command — they block the terminal.",
  "",
  "Efficiency:",
  "- Use run_command with ls, find, sed, awk, grep, wc, etc. A single shell pipeline replaces dozens of tool calls.",
  "- For data collection tasks (counting lines, searching files): write ONE shell command, never do it file-by-file.",
  "- Call multiple tools in one turn when operations are independent.",
  "- Don't verify results unless there's a reason to doubt them.",
  "- Keep tool outputs concise — pipe through head, tail, or grep.",
  "",
  "File editing:",
  "- Use write_file for CREATING new files. Use replace_in_file for MODIFYING existing files.",
  "- Use append_file only for true append-only artifacts (logs, notes, markdown sections).",
  "- Only use write_file to modify an existing file when you need to change MORE THAN HALF of its content.",
  "",
  "Internet access:",
  "- You CAN access the internet. Use fetch_url to read any web page or API.",
  "- For interactive web tasks (clicking buttons, filling forms, navigating multi-page flows), use browse_web which gives you a persistent browser session.",
  "- When you need information from the user (credentials, details, choices), use ask_user.",
  "",
  "Delegation:",
  "- When splitting work across child agents, prefer delegate_parallel for independent tasks rather than chaining sequential delegates.",
  "- Each child is a focused worker — give it a precise, self-contained goal with ALL necessary context.",
  "- AFTER EVERY delegation result, your VERY NEXT action MUST be a verification tool call.",
  "- If verification reveals issues, re-delegate with corrective feedback. Max 2 rework attempts per task.",
  "",
  "Verification:",
  "- After creating or modifying web projects (HTML/JS/CSS), use browser_check AND read_file to verify real logic exists.",
  "- browser_check only tests if the page LOADS — it does NOT verify correctness.",
  "- After creating testable code, run it with run_command to verify it works end-to-end.",
  "- NEVER provide a final answer based solely on a delegation summary.",
  "",
  "Failure recovery:",
  "- NEVER repeat the same command after it fails. Read the error and try a fundamentally different approach.",
  "- After 2 failed attempts at the same task, stop and re-assess entirely.",
  "",
  "Provide a concise final answer when done.",
].join("\n")

const DEFAULT_TOOLS = ["read_file", "write_file", "append_file", "replace_in_file", "list_directory", "search_files", "run_command", "think", "fetch_url", "browser_check", "browse_web", "ask_user", "query_mssql", "explore_mssql_schema"]

/** @internal — exported for testing. */
export function _migrate(db: Database.Database): void {
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

  // Column migrations
  const addColumnIfMissing = (sql: string): void => {
    try {
      db.exec(sql)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("duplicate column")) throw err
    }
  }
  addColumnIfMissing("ALTER TABLE runs ADD COLUMN agent_id TEXT")

  // Seed default agent
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

  // Seed default policies
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

  // Version-based seed update
  const currentSeedVersion = Number(getMetaValue("seed_version") ?? "0")
  if (currentSeedVersion < SEED_VERSION) {
    const existing = db.prepare(
      "SELECT system_prompt, tools FROM agent_definitions WHERE id = 'default'"
    ).get() as { system_prompt: string; tools: string } | undefined

    if (existing) {
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

function isKnownOldSeedPrompt(prompt: string): boolean {
  if (prompt.includes("Break it down into steps")) return true
  if (prompt.includes("You are an efficient AI agent that uses tools")) return true
  return false
}
