/**
 * Database connection — singleton SQLite instance.
 *
 * All domain-specific persistence modules import getDb() from here.
 * Data lives in ~/.mia/mia.db — survives server restarts.
 * Env override: MIA_DATA_DIR.
 */

import { DEFAULT_SYSTEM_PROMPT } from "@mia/agent"
import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DATA_DIR = process.env["MIA_DATA_DIR"] || join(homedir(), ".mia")
mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = join(DATA_DIR, "mia.db")

/** Absolute path to the on-disk SQLite file (for logging / diagnostics). */
export function getDbPath(): string {
  return DB_PATH
}

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH)
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
// Bumping SEED_VERSION past the threshold triggers a one-time hard reset
// of every app table EXCEPT `llm_config` (whose row is preserved). All
// other tables are re-created from scratch with the declarative schema
// below. Use sparingly — this WILL drop data; only safe in dev.

const SEED_VERSION = 14
const HARD_RESET_THRESHOLD = 14

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

  // ── Hard reset: drop every app table except llm_config + schema_meta ──
  // This is the entry point for the v14 redesign. We need it because
  // SQLite cannot ALTER existing tables to add foreign keys; the only way
  // to introduce the new FK graph is to re-create from scratch. Triggered
  // exactly once per database file (gated by schema_meta.seed_version).
  const currentSeedVersion = Number(getMetaValue("seed_version") ?? "0")
  if (currentSeedVersion < HARD_RESET_THRESHOLD) {
    db.pragma("foreign_keys = OFF")
    // FTS5 shadow tables (memory_entries_fts_data, _idx, _docsize, _config,
    // _content) cannot be dropped directly — SQLite errors with "table X
    // may not be dropped". They're auto-managed by the parent virtual
    // table, so we drop virtual tables first and SQLite cascades the
    // shadow drops, then drop the remaining regular tables/views.
    const virtualTables = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND sql LIKE 'CREATE VIRTUAL TABLE%'
         AND name NOT IN ('llm_config','schema_meta')`,
    ).all() as { name: string }[]
    for (const { name } of virtualTables) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`)
    }
    const remainingTables = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table','view')
         AND name NOT LIKE 'sqlite_%'
         AND name NOT IN ('llm_config','schema_meta')`,
    ).all() as { name: string }[]
    for (const { name } of remainingTables) {
      db.exec(`DROP TABLE IF EXISTS "${name}"`)
    }
    db.pragma("foreign_keys = ON")
  }

  // ── Schema (declarative; created in dependency order so FKs resolve) ──
  db.exec(`
    -- ── llm_config (singleton, preserved across hard resets) ─────
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

    -- ── sessions: identity root for the entire user-scoped graph ──
    -- Anonymous browsers get persisted too (sid 'anon:<hex>' or
    -- 'header:<upn>') so that runs.session_id can be a hard FK.
    CREATE TABLE IF NOT EXISTS sessions (
      sid          TEXT PRIMARY KEY,
      upn          TEXT,
      display_name TEXT,
      ip           TEXT,
      user_agent   TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_upn       ON sessions(upn);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at);

    -- ── agent_definitions ────────────────────────────────────────
    -- The 'tools' column has been dropped: tools are always resolved from
    -- ALL_TOOLS in code, never from the DB.
    CREATE TABLE IF NOT EXISTS agent_definitions (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL UNIQUE,
      description   TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── runs: every run is tied to a session (hard FK) ───────────
    -- parent_run_id and agent_id use SET NULL so deleting a parent run
    -- or agent definition leaves the child row intact for audit.
    -- The legacy 'data' column has been dropped (was never read).
    CREATE TABLE IF NOT EXISTS runs (
      id             TEXT PRIMARY KEY,
      goal           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      answer         TEXT,
      step_count     INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      parent_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
      agent_id       TEXT REFERENCES agent_definitions(id) ON DELETE SET NULL,
      session_id     TEXT NOT NULL REFERENCES sessions(sid) ON DELETE CASCADE,
      upn            TEXT,
      display_name   TEXT,
      created_at     TEXT NOT NULL,
      completed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_upn     ON runs(upn, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_parent  ON runs(parent_run_id);

    -- ── Run-owned children (all CASCADE on run deletion) ─────────
    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      actor     TEXT NOT NULL,
      action    TEXT NOT NULL,
      detail    TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id);

    CREATE TABLE IF NOT EXISTS checkpoints (
      run_id       TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      messages     TEXT NOT NULL,
      iteration    INTEGER NOT NULL DEFAULT 0,
      step_counter INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      level     TEXT NOT NULL DEFAULT 'info',
      message   TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_logs_run ON logs(run_id);

    CREATE TABLE IF NOT EXISTS token_usage (
      run_id            TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens      INTEGER NOT NULL DEFAULT 0,
      llm_calls         INTEGER NOT NULL DEFAULT 0,
      model             TEXT NOT NULL DEFAULT 'gpt-4o',
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trace_entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq        INTEGER NOT NULL DEFAULT 0,
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trace_run ON trace_entries(run_id, seq);

    -- ── Layouts (UI widget arrangements; not user-scoped) ────────
    CREATE TABLE IF NOT EXISTS layouts (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      config     TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- ── Policy rules (governance) ────────────────────────────────
    CREATE TABLE IF NOT EXISTS policy_rules (
      name       TEXT PRIMARY KEY,
      effect     TEXT NOT NULL,
      condition  TEXT NOT NULL,
      parameters TEXT NOT NULL DEFAULT '{}',
      source     TEXT NOT NULL DEFAULT 'db',
      created_at TEXT NOT NULL,
      updated_at TEXT,
      updated_by TEXT
    );

    -- ── Sync runs: typed totals + recipe name promoted from JSON ──
    -- plan_json kept as audit snapshot for History modal rehydration.
    -- actor_upn NOT NULL — anonymous syncs use 'sid:<sid>' format so
    -- there is always a stable owner for filtering.
    -- entity_type doubles as the recipe identifier (Employee, Role, etc.).
    -- actor_upn NOT NULL; anonymous syncs use 'sid:<sid>' so there is always
    -- a stable owner for filtering. Promoted preview/executed counters live
    -- alongside the JSON snapshots so list-views and reports don't need to
    -- parse JSON to render row counts or filter by drift.
    CREATE TABLE IF NOT EXISTS sync_runs (
      plan_id              TEXT PRIMARY KEY,
      entity_type          TEXT NOT NULL,
      entity_id            TEXT NOT NULL,
      entity_display_name  TEXT,
      source               TEXT NOT NULL,
      target               TEXT NOT NULL,
      actor_upn            TEXT NOT NULL,
      preview_inserts      INTEGER NOT NULL DEFAULT 0,
      preview_updates      INTEGER NOT NULL DEFAULT 0,
      preview_deletes      INTEGER NOT NULL DEFAULT 0,
      executed_inserts     INTEGER,
      executed_updates     INTEGER,
      executed_deletes     INTEGER,
      preview_totals_json  TEXT NOT NULL,
      execute_totals_json  TEXT,
      plan_json            TEXT,
      status               TEXT NOT NULL,
      error                TEXT,
      drift_detected_pct   REAL,
      started_at           TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at          TEXT,
      duration_ms          INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_target  ON sync_runs(target);
    CREATE INDEX IF NOT EXISTS idx_sync_runs_actor   ON sync_runs(actor_upn);

    -- ── Sync audit (sync-scoped, FK to sync_runs) ────────────────
    -- Replaces the old hack of stuffing 'sync:<planId>' into
    -- audit_log.run_id. Lets us cascade-delete sync history with
    -- the parent plan and keeps audit_log strictly run-scoped.
    CREATE TABLE IF NOT EXISTS sync_audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id    TEXT NOT NULL REFERENCES sync_runs(plan_id) ON DELETE CASCADE,
      actor      TEXT NOT NULL,
      actor_upn  TEXT,
      action     TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '{}',
      timestamp  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_audit_plan ON sync_audit(plan_id);
    CREATE INDEX IF NOT EXISTS idx_sync_audit_time ON sync_audit(timestamp DESC);

    -- ── Sync-environment overrides (admin-editable on top of JSON) ──
    CREATE TABLE IF NOT EXISTS sync_environment_overrides (
      name           TEXT PRIMARY KEY,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      updated_at     TEXT NOT NULL,
      updated_by     TEXT
    );

    -- ── Attachments ──────────────────────────────────────────────
    -- session_id and run_id are nullable to support 'workspace_asset'
    -- scope (cross-session / cross-run org assets), but FKs cascade
    -- when the parent session or run is deleted.
    CREATE TABLE IF NOT EXISTS attachments (
      id              TEXT PRIMARY KEY,
      scope           TEXT NOT NULL,             -- 'run' | 'session' | 'workspace_asset'
      run_id          TEXT REFERENCES runs(id)     ON DELETE SET NULL,
      session_id      TEXT REFERENCES sessions(sid) ON DELETE CASCADE,
      owner_upn       TEXT,
      original_name   TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      size_bytes      INTEGER NOT NULL,
      content_hash    TEXT NOT NULL,
      storage_uri     TEXT NOT NULL,
      text_extract_uri TEXT,
      ingestion_mode  TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'uploaded',
      source          TEXT NOT NULL DEFAULT 'user_upload',
      purpose_tag     TEXT,
      goal_snapshot   TEXT,
      uploaded_at     TEXT NOT NULL,
      processed_at    TEXT,
      retention_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_run     ON attachments(run_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_owner   ON attachments(owner_upn);
    CREATE INDEX IF NOT EXISTS idx_attachments_hash    ON attachments(content_hash);

    CREATE TABLE IF NOT EXISTS attachment_tags (
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      tag_key       TEXT NOT NULL,
      tag_value     TEXT NOT NULL,
      PRIMARY KEY (attachment_id, tag_key, tag_value)
    );

    CREATE TABLE IF NOT EXISTS attachment_imports (
      id                    TEXT PRIMARY KEY,
      attachment_id         TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      run_id                TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sandbox_path          TEXT NOT NULL,
      import_mode           TEXT NOT NULL,
      imported_at           TEXT NOT NULL,
      imported_by_tool_call TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_imports_run ON attachment_imports(run_id);
  `)

  // Seed default agent (no `tools` column anymore)
  db.prepare(`
    INSERT OR IGNORE INTO agent_definitions (id, name, description, system_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    "default",
    "Universal Agent",
    "General-purpose agent with all tools. Handles any task.",
    DEFAULT_SYSTEM_PROMPT,
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

  // Bump system_prompt on the default agent if the seed version advanced
  // and the operator hasn't customised it. Tools column no longer exists,
  // so this is now a single-column update path.
  if (currentSeedVersion < SEED_VERSION) {
    const existing = db.prepare(
      "SELECT system_prompt FROM agent_definitions WHERE id = 'default'"
    ).get() as { system_prompt: string } | undefined
    if (existing && isKnownOldSeedPrompt(existing.system_prompt)) {
      db.prepare(
        "UPDATE agent_definitions SET system_prompt = ?, updated_at = datetime('now') WHERE id = 'default'"
      ).run(DEFAULT_SYSTEM_PROMPT)
    }
    setMetaValue("seed_version", String(SEED_VERSION))
  }
}

function isKnownOldSeedPrompt(prompt: string): boolean {
  if (prompt.includes("Break it down into steps")) return true
  if (prompt.includes("You are an efficient AI agent that uses tools")) return true
  return false
}
