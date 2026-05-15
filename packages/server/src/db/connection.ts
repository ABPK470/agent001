/**
 * Database connection — singleton SQLite instance.
 *
 * All domain-specific persistence modules import getDb() from here.
 * Data lives in ~/.mia/mia.db — survives server restarts.
 * Env override: MIA_DATA_DIR.
 */

import { DEFAULT_SYSTEM_PROMPT, PolicyEffect } from "@mia/agent"
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

// ── Schema version (bump SCHEMA_VERSION when changing) ──────
// Bumping SCHEMA_VERSION past the threshold triggers a one-time hard reset
// of every app table EXCEPT `llm_config` (whose row is preserved). All
// other tables are re-created from scratch with the declarative schema
// below. Use sparingly — this WILL drop data; only safe in dev.

export const SCHEMA_VERSION = 19
const SEED_VERSION = SCHEMA_VERSION
// v19: introduce real `users` table; identity is no longer self-declared.
// upn becomes NOT NULL FK on every per-user table. Triggers a one-time
// hard reset of all app data — only safe in dev (the project has no prod
// data yet).
const HARD_RESET_THRESHOLD = 19

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
      provider TEXT NOT NULL DEFAULT 'copilot-chat',
      model TEXT NOT NULL DEFAULT 'gpt-5.4',
      api_key TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO llm_config (id, provider, model, api_key, base_url, updated_at)
    VALUES (1, 'copilot-chat', 'gpt-5.4', '', '', datetime('now'));
    -- One-shot migration: providers we no longer support get rewritten to
    -- the safe default. Idempotent — re-running on already-migrated rows
    -- is a no-op because the WHERE clause matches nothing.
    UPDATE llm_config
       SET provider = 'copilot-chat',
           model    = 'gpt-5.4',
           api_key  = '',
           base_url = '',
           updated_at = datetime('now')
     WHERE provider IN ('copilot', 'openai', 'anthropic', 'github-models', 'local');

    -- ── users: real accounts (local password OR SSO header-derived) ──
    -- v19: identity is no longer self-declared in a welcome modal. Every
    -- request now requires a verified user (or a 401). The upn column is
    -- the canonical identifier — referenced as FK by every per-user table.
    --
    -- source = 'local'  → password_hash is bcrypt, set via /api/auth/register.
    -- source = 'sso'    → password_hash is NULL, user was created on-the-fly
    --                     when an authenticated proxy header arrived.
    -- is_admin is a boolean column — replaces the previous MIA_ADMIN_UPNS
    -- env whitelist + ADMIN_COOKIE + AdminLoginModal triple.
    CREATE TABLE IF NOT EXISTS users (
      upn           TEXT PRIMARY KEY,
      username      TEXT UNIQUE,
      display_name  TEXT NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
      password_hash TEXT,
      source        TEXT NOT NULL CHECK (source IN ('local','sso')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      last_login_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

    -- ── sessions: opaque transport tokens, FK to users ──────────
    -- Sid identifies a browser/SSE socket. One user can have many
    -- sessions (multiple tabs/devices). Login inserts; logout deletes;
    -- onRequest validates by sid lookup.
    CREATE TABLE IF NOT EXISTS sessions (
      sid          TEXT PRIMARY KEY,
      upn          TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
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
      status         TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','planning','running','waiting_for_approval','completed','failed','cancelled')),
      answer         TEXT,
      step_count     INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      parent_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
      agent_id       TEXT REFERENCES agent_definitions(id) ON DELETE SET NULL,
      session_id     TEXT NOT NULL REFERENCES sessions(sid) ON DELETE CASCADE,
      upn            TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      display_name   TEXT NOT NULL,
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
      model             TEXT NOT NULL DEFAULT 'gpt-5.4',
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
      effect     TEXT NOT NULL
        CHECK (effect IN ('allow','require_approval','deny')),
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
      actor_upn            TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      preview_inserts      INTEGER NOT NULL DEFAULT 0,
      preview_updates      INTEGER NOT NULL DEFAULT 0,
      preview_deletes      INTEGER NOT NULL DEFAULT 0,
      executed_inserts     INTEGER,
      executed_updates     INTEGER,
      executed_deletes     INTEGER,
      preview_totals_json  TEXT NOT NULL,
      execute_totals_json  TEXT,
      plan_json            TEXT,
      status               TEXT NOT NULL
        CHECK (status IN ('started','preview','success','failed')),
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
      actor_upn  TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
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
      scope           TEXT NOT NULL
        CHECK (scope IN ('run','session','workspace_asset')),
      run_id          TEXT REFERENCES runs(id)     ON DELETE SET NULL,
      session_id      TEXT REFERENCES sessions(sid) ON DELETE CASCADE,
      owner_upn       TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      original_name   TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      media_type      TEXT NOT NULL,
      size_bytes      INTEGER NOT NULL,
      content_hash    TEXT NOT NULL,
      storage_uri     TEXT NOT NULL,
      text_extract_uri TEXT,
      ingestion_mode  TEXT NOT NULL
        CHECK (ingestion_mode IN ('text_inline','text_retrieval','binary_reference','provider_file_api')),
      status          TEXT NOT NULL DEFAULT 'uploaded'
        CHECK (status IN ('uploaded','processed','rejected','deleted')),
      source          TEXT NOT NULL DEFAULT 'user_upload'
        CHECK (source IN ('user_upload','generated','promoted')),
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
      import_mode           TEXT NOT NULL
        CHECK (import_mode IN ('copy','reference')),
      imported_at           TEXT NOT NULL,
      imported_by_tool_call TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attachment_imports_run ON attachment_imports(run_id);

    -- ── Browser contexts (persistent per-user storage state) ─────
    -- Keeps cookies / localStorage / IndexedDB scoped to a tenant so the
    -- agent can stay logged in across runs. Anonymous sessions get
    -- ephemeral contexts that are NOT persisted (no row written).
    --
    -- owner_upn is the canonical tenant key for authenticated users.
    -- storage_path is a relative path under ~/.mia/browser-contexts/
    -- (resolved by context-store.ts) holding the JSON storageState file.
    -- fingerprint_seed is captured once and reused so the same tenant
    -- always gets the same UA / viewport / locale / timezone.
    CREATE TABLE IF NOT EXISTS browser_contexts (
      id               TEXT PRIMARY KEY,
      owner_upn        TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      storage_path     TEXT NOT NULL,
      fingerprint_seed TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_contexts_owner ON browser_contexts(owner_upn);
    CREATE INDEX IF NOT EXISTS idx_browser_contexts_last_used   ON browser_contexts(last_used_at);

    -- ── Browser credentials (vault-encrypted) ────────────────────
    -- Per-user credentials the agent uses for auto-login. NEVER stored
    -- plaintext — every payload is encrypted with the master vault key
    -- (see crypto/vault.ts). Anonymous sessions cannot create or use
    -- credentials (owner_upn is NOT NULL).
    --
    -- kind:
    --   password   — { username, password } JSON
    --   totp       — { secret, digits?, period? } JSON (otplib config)
    --   cookie_jar — Playwright storageState JSON (manual import path)
    CREATE TABLE IF NOT EXISTS browser_credentials (
      id             TEXT PRIMARY KEY,
      owner_upn      TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      label          TEXT NOT NULL,
      kind           TEXT NOT NULL CHECK (kind IN ('password','totp','cookie_jar')),
      target_origin  TEXT NOT NULL,
      enc_payload    BLOB NOT NULL,
      iv             BLOB NOT NULL,
      auth_tag       BLOB NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_browser_credentials_owner  ON browser_credentials(owner_upn);
    CREATE INDEX IF NOT EXISTS idx_browser_credentials_origin ON browser_credentials(target_origin);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_browser_credentials_label
      ON browser_credentials(owner_upn, label);

    -- ── Browser proxy config (BYO, vault-encrypted URL) ──────────
    -- Per-user upstream proxy. Plain http(s) or socks5 URL the user
    -- supplies; encrypted at rest like credentials. NULL row means
    -- "use direct connection". Anonymous sessions never get a row.
    CREATE TABLE IF NOT EXISTS browser_proxy_config (
      owner_upn   TEXT PRIMARY KEY REFERENCES users(upn) ON DELETE CASCADE,
      enc_url     BLOB NOT NULL,
      iv          BLOB NOT NULL,
      auth_tag    BLOB NOT NULL,
      bypass      TEXT NOT NULL DEFAULT '',
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Browser domain policy ────────────────────────────────────
    -- Default-deny / default-allow toggle is implicit in evaluator:
    -- deny-list is checked first, then allow-list (if any allow rows
    -- exist for the tenant the policy becomes default-deny). Patterns
    -- are domain globs ("*.example.com" = match host or any subdomain).
    -- effect ∈ {allow, deny}. owner_upn = NULL means a global rule that
    -- applies to every authenticated tenant (admin-managed).
    -- owner_upn nullable here on purpose: NULL = admin-defined global rule
    -- that applies to every authenticated user.
    CREATE TABLE IF NOT EXISTS browser_domain_policy (
      id          TEXT PRIMARY KEY,
      owner_upn   TEXT REFERENCES users(upn) ON DELETE CASCADE,
      pattern     TEXT NOT NULL,
      effect      TEXT NOT NULL CHECK (effect IN ('allow','deny')),
      reason      TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_browser_policy_owner ON browser_domain_policy(owner_upn);

    -- ── Browser audit log ────────────────────────────────────────
    -- Every navigation, search, credential use, and handoff is appended
    -- here so admins can answer "what did agent X do on user Y's behalf
    -- last week?". Append-only; pruned by the existing pruneOldData job.
    CREATE TABLE IF NOT EXISTS browser_audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_upn   TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
      action      TEXT NOT NULL,
      target_url  TEXT,
      detail      TEXT,
      decision    TEXT NOT NULL DEFAULT 'allow'
        CHECK (decision IN ('allow','deny','captcha','error')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_browser_audit_owner ON browser_audit_log(owner_upn, created_at DESC);
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
  const seedPolicies: { name: string; effect: PolicyEffect; condition: string; parameters: string }[] = [
    { name: "Tool Permission", effect: PolicyEffect.Allow, condition: "tool_call", parameters: JSON.stringify({ scope: "all_tools", description: "Controls which tools agents are permitted to invoke" }) },
    { name: "Model", effect: PolicyEffect.Allow, condition: "model_selection", parameters: JSON.stringify({ scope: "all_models", description: "Controls model selection and usage limits" }) },
    { name: "Security", effect: PolicyEffect.RequireApproval, condition: "sensitive_action", parameters: JSON.stringify({ scope: "destructive_ops", description: "Requires approval for destructive or sensitive operations" }) },
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
