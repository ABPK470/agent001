/**
 * Database connection — singleton SQLite instance.
 *
 * All domain-specific persistence modules import getDb() from here.
 * Data lives in ~/.mia/mia.db — survives server restarts.
 * Env override: MIA_DATA_DIR.
 */

import { BUNDLED_SCD2_STRATEGIES, DEFAULT_SYSTEM_PROMPT, PolicyEffect } from "@mia/agent"
import Database from "better-sqlite3"
import { createHash } from "node:crypto"
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

export const SCHEMA_VERSION = 23
const SEED_VERSION = SCHEMA_VERSION
// v19: introduce real `users` table; identity is no longer self-declared.
//      upn becomes NOT NULL FK on every per-user table. Triggers a one-time
//      hard reset of all app data — only safe in dev (the project has no
//      prod data yet).
// v20: introduce entity registry (Phase 0 config uplift). Adds tables
//      `scd2_strategies`, `scd2_strategy_versions`, `entity_defs`,
//      `entity_def_versions` with append-only triggers on the *_versions
//      tables (immutable history). Non-breaking — new tables only — so
//      HARD_RESET_THRESHOLD stays at 19. On boot we seed the bundled
//      SCD2 strategies into the `_default` tenant if they're missing.
// v21: introduce F1 reconciliation-proposer subsystem. Adds tables
//      `proposer_runs`, `sync_proposals`, `sync_proposal_history`,
//      `sync_approvals`, `sync_approval_tokens`, `sync_evidence`,
//      `notification_routes`, `notification_log`,
//      `approval_policies`, `proposer_schedule`. All additive — no
//      hard reset required.
// v22: redesign `audit_log` so admin actions are first-class audit
//      entries instead of fake sentinel runs. `audit_log.run_id`
//      becomes nullable; add `scope_type` + `scope_id`; migrate
//      historical `__admin__` rows and remove sentinel bootstrap rows.
// v23: introduce `agent_messages` table for the inter-agent bus.
//      Persistence-backed AgentBus replaces the in-memory ring buffer
//      so siblings spawned later in the run tree see prior coordination,
//      the IOE BusFeed editor can replay after reconnect, and Help/
//      Question protocol messages survive client disconnects. Additive
//      table + indexes only; no hard reset.
const HARD_RESET_THRESHOLD = 19

function tableSessionFkIsCascade(db: Database.Database, table: string): boolean {
  // PRAGMA foreign_key_list(table) returns one row per FK with `table`,
  // `from` column, `on_delete` action. Return true iff the row for
  // session_id -> sessions still says CASCADE (the old, buggy default).
  const rows = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
    table: string; from: string; on_delete: string
  }>
  return rows.some((r) => r.table === "sessions" && r.from === "session_id" && r.on_delete === "CASCADE")
}

/** Detect runs tables built before `'crashed'` was added to the status
 *  CHECK constraint. Inspects the stored CREATE TABLE SQL from
 *  sqlite_master rather than parsing it — looking for the literal token
 *  `'crashed'` is sufficient because the only place it could appear is
 *  inside the status CHECK clause. */
function runsTableMissingCrashedStatus(db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'",
  ).get() as { sql?: string } | undefined
  if (!row?.sql) return false
  return !row.sql.includes("'crashed'")
}

/**
 * v23: change every `session_id` FK from `ON DELETE CASCADE` to
 * `ON DELETE SET NULL` so that `DELETE FROM sessions` (i.e. a normal
 * user logout) no longer cascade-deletes the user's runs, attachments,
 * notifications, and memories. Logout is supposed to be idempotent at
 * the user-data layer: the session row goes, the audit trail and chat
 * history stay.
 *
 * Also drops the `NOT NULL` on `runs.session_id`. After a session row
 * is deleted, the FK now nulls the field — keeping NOT NULL would make
 * the cascade fail or force re-introducing the bug.
 *
 * Idempotent — only rewrites tables whose foreign_key_list still says
 * CASCADE on the session FK.
 */
export function migrateSessionFkSetNull(db: Database.Database): void {
  const ddl: Record<string, string> = {
    runs: `
      CREATE TABLE runs__v23 (
        id             TEXT PRIMARY KEY,
        goal           TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','planning','running','waiting_for_approval','completed','failed','cancelled','crashed')),
        answer         TEXT,
        step_count     INTEGER NOT NULL DEFAULT 0,
        error          TEXT,
        parent_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
        agent_id       TEXT REFERENCES agent_definitions(id) ON DELETE SET NULL,
        session_id     TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
        upn            TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
        display_name   TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        completed_at   TEXT
      );
    `,
    attachments: `
      CREATE TABLE attachments__v23 (
        id              TEXT PRIMARY KEY,
        scope           TEXT NOT NULL
          CHECK (scope IN ('run','session','workspace_asset')),
        run_id          TEXT REFERENCES runs(id)     ON DELETE SET NULL,
        session_id      TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
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
    `,
    notifications: `
      CREATE TABLE notifications__v23 (
        id         TEXT PRIMARY KEY,
        type       TEXT NOT NULL,
        title      TEXT NOT NULL,
        message    TEXT NOT NULL,
        run_id     TEXT REFERENCES runs(id)     ON DELETE CASCADE,
        step_id    TEXT,
        owner_upn  TEXT NOT NULL REFERENCES users(upn) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
        actions    TEXT NOT NULL DEFAULT '[]',
        read       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `,
    memory_entries: `
      CREATE TABLE memory_entries__v23 (
        id           TEXT PRIMARY KEY,
        tier         TEXT NOT NULL CHECK (tier IN ('working', 'episodic', 'semantic')),
        role         TEXT NOT NULL DEFAULT 'assistant'
          CHECK (role IN ('user','assistant','tool','system','summary')),
        content      TEXT NOT NULL,
        metadata     TEXT NOT NULL DEFAULT '{}',
        source       TEXT NOT NULL DEFAULT 'agent'
          CHECK (source IN ('system','tool','user','agent','external')),
        confidence   REAL NOT NULL DEFAULT 0.5,
        salience     REAL NOT NULL DEFAULT 0.5,
        access_count INTEGER NOT NULL DEFAULT 0,
        session_id   TEXT REFERENCES sessions(sid)      ON DELETE SET NULL,
        run_id       TEXT REFERENCES runs(id)           ON DELETE SET NULL,
        parent_id    TEXT REFERENCES memory_entries(id) ON DELETE SET NULL,
        upn          TEXT,
        shared       INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `,
    procedural_memories: `
      CREATE TABLE procedural_memories__v23 (
        id            TEXT PRIMARY KEY,
        trigger       TEXT NOT NULL,
        tool_sequence TEXT NOT NULL,
        success_count INTEGER NOT NULL DEFAULT 1,
        failure_count INTEGER NOT NULL DEFAULT 0,
        run_id        TEXT REFERENCES runs(id)      ON DELETE SET NULL,
        session_id    TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
        upn           TEXT,
        shared        INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );
    `,
  }
  // Indexes to recreate per table after the rebuild (table-rebuild drops
  // them along with the original table).
  const indexes: Record<string, string[]> = {
    runs: [
      `CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_runs_upn     ON runs(upn, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_runs_parent  ON runs(parent_run_id);`,
    ],
    attachments: [
      `CREATE INDEX IF NOT EXISTS idx_attachments_run     ON attachments(run_id);`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_owner   ON attachments(owner_upn);`,
      `CREATE INDEX IF NOT EXISTS idx_attachments_hash    ON attachments(content_hash);`,
    ],
    notifications: [
      `CREATE INDEX IF NOT EXISTS idx_notifications_read     ON notifications(read, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_owner    ON notifications(owner_upn, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_session  ON notifications(session_id, created_at DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_run      ON notifications(run_id);`,
    ],
    memory_entries: [
      `CREATE INDEX IF NOT EXISTS idx_me_tier    ON memory_entries(tier);`,
      `CREATE INDEX IF NOT EXISTS idx_me_session ON memory_entries(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_me_run     ON memory_entries(run_id);`,
      `CREATE INDEX IF NOT EXISTS idx_me_created ON memory_entries(created_at);`,
      `CREATE INDEX IF NOT EXISTS idx_me_upn     ON memory_entries(upn);`,
      `CREATE INDEX IF NOT EXISTS idx_me_shared  ON memory_entries(shared);`,
    ],
    procedural_memories: [
      `CREATE INDEX IF NOT EXISTS idx_proc_upn     ON procedural_memories(upn);`,
      `CREATE INDEX IF NOT EXISTS idx_proc_session ON procedural_memories(session_id);`,
      `CREATE INDEX IF NOT EXISTS idx_proc_shared  ON procedural_memories(shared);`,
    ],
  }

  const tableExists = (name: string): boolean =>
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)

  const work: string[] = []
  for (const table of Object.keys(ddl)) {
    if (!tableExists(table)) continue
    if (tableSessionFkIsCascade(db, table)) work.push(table)
  }
  // Also rebuild `runs` if its status CHECK constraint predates the
  // addition of 'crashed' (v23-era schema). Idempotent — the rebuild
  // produces a runs table whose stored SQL contains 'crashed', so
  // subsequent boots short-circuit here.
  if (tableExists("runs") && !work.includes("runs") && runsTableMissingCrashedStatus(db)) {
    work.push("runs")
  }
  if (work.length === 0) return

  db.pragma("foreign_keys = OFF")
  const tx = db.transaction(() => {
    for (const table of work) {
      db.exec(ddl[table]!)
      // Copy all rows by column list — the new table has the same
      // columns in the same order so SELECT * INTO is unambiguous. We
      // also copy the rowid so any external indices (e.g. memory's FTS5
      // shadow tables that reference memory_entries by rowid) stay valid.
      const cols = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
        .map((c) => `"${c.name}"`)
        .join(", ")
      db.exec(`INSERT INTO "${table}__v23" (rowid, ${cols}) SELECT rowid, ${cols} FROM "${table}";`)
      db.exec(`DROP TABLE "${table}";`)
      db.exec(`ALTER TABLE "${table}__v23" RENAME TO "${table}";`)
      for (const idx of indexes[table] ?? []) db.exec(idx)
    }
  })
  tx()
  db.pragma("foreign_keys = ON")
  // Sanity check — the new FK graph must still be internally consistent.
  // Throw loud rather than silently leaving the DB in a broken state.
  const violations = db.pragma("foreign_key_check") as Array<{ table: string; rowid: number; parent: string }>
  if (violations.length > 0) {
    throw new Error(
      `migrateSessionFkSetNull: foreign_key_check found ${violations.length} violations after rebuild: ${
        JSON.stringify(violations.slice(0, 5))
      }`,
    )
  }
}

function migrateAuditLogScopes(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(audit_log)").all() as Array<{ name: string; notnull: number }>
  if (columns.length === 0) return
  const hasScopeType = columns.some((c) => c.name === "scope_type")
  const runIdColumn = columns.find((c) => c.name === "run_id")
  if (hasScopeType && runIdColumn?.notnull === 0) return

  db.pragma("foreign_keys = OFF")
  db.exec(`
    CREATE TABLE audit_log_v22 (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT REFERENCES runs(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL DEFAULT 'run'
        CHECK (scope_type IN ('run','admin')),
      scope_id   TEXT,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '{}',
      timestamp  TEXT NOT NULL
    );

    INSERT INTO audit_log_v22 (id, run_id, scope_type, scope_id, actor, action, detail, timestamp)
    SELECT
      id,
      CASE WHEN run_id = '__admin__' THEN NULL ELSE run_id END,
      CASE WHEN run_id = '__admin__' THEN 'admin' ELSE 'run' END,
      CASE WHEN run_id = '__admin__' THEN 'platform' ELSE run_id END,
      actor,
      action,
      detail,
      timestamp
    FROM audit_log;

    DROP TABLE audit_log;
    ALTER TABLE audit_log_v22 RENAME TO audit_log;
    CREATE INDEX IF NOT EXISTS idx_audit_run   ON audit_log(run_id);
    CREATE INDEX IF NOT EXISTS idx_audit_scope ON audit_log(scope_type, scope_id, timestamp DESC);
  `)
  db.prepare("DELETE FROM runs WHERE id = '__admin__'").run()
  db.prepare("DELETE FROM sessions WHERE sid = '__system__'").run()
  db.prepare("DELETE FROM users WHERE upn = '__system__'").run()
  db.pragma("foreign_keys = ON")
}

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

    -- ── runs: every run is owned by a user (hard FK on upn). ─────
    -- session_id is captured for traceability but uses SET NULL on
    -- delete: logout (DELETE FROM sessions) must NOT cascade-wipe
    -- the user's chat history. parent_run_id and agent_id likewise
    -- SET NULL so deleting a parent run or agent definition leaves
    -- the child row intact for audit. The legacy 'data' column has
    -- been dropped (was never read).
    CREATE TABLE IF NOT EXISTS runs (
      id             TEXT PRIMARY KEY,
      goal           TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','planning','running','waiting_for_approval','completed','failed','cancelled','crashed')),
      answer         TEXT,
      step_count     INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      parent_run_id  TEXT REFERENCES runs(id) ON DELETE SET NULL,
      agent_id       TEXT REFERENCES agent_definitions(id) ON DELETE SET NULL,
      session_id     TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
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
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT REFERENCES runs(id) ON DELETE CASCADE,
      scope_type TEXT NOT NULL DEFAULT 'run'
        CHECK (scope_type IN ('run','admin')),
      scope_id   TEXT,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '{}',
      timestamp  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_run   ON audit_log(run_id);

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

    -- ── Structured tool-call results (no-amnesia grounding) ──────
    -- The "I made up the chart numbers" trap: prior to this table the
    -- only cross-turn record of what a tool produced was the model's
    -- own prose paraphrase in runs.answer. That prose got re-injected
    -- as <prior_turns>, the model treated its own paraphrase as
    -- evidence, and confabulated quantified output. tool_results stores
    -- the raw structured payload of every tool call so a later turn
    -- (same session) can ground on actual rows instead of paraphrase.
    --
    -- result_json is JSON-text (SQLite has no native JSON column type).
    -- Capped writers MUST enforce {row_count, bytes, truncated} so a
    -- 10M-row export never lands here verbatim — see writer in
    -- agent/src/agent/iteration-tool-round.ts.
    --
    -- session_id is denormalised for fast loader queries on the hot
    -- path (<prior_results> rendered every turn). FK still points to
    -- runs(id) for cascade-on-purge.
    CREATE TABLE IF NOT EXISTS tool_results (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      session_id    TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
      tool_call_id  TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      args_json     TEXT NOT NULL DEFAULT '{}',
      result_json   TEXT NOT NULL,
      row_count     INTEGER,
      bytes         INTEGER NOT NULL DEFAULT 0,
      truncated     INTEGER NOT NULL DEFAULT 0,
      goal_excerpt  TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_results_run     ON tool_results(run_id);
    CREATE INDEX IF NOT EXISTS idx_tool_results_session ON tool_results(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tool_results_tool    ON tool_results(tool_name);

    -- ── Inter-agent bus messages ─────────────────────────────────
    -- Persisted so siblings spawned later in the same run tree see the
    -- full history (wildcard subscribe), so the IOE BusFeed editor can
    -- replay coordination after reconnect, and so audit/forensics can
    -- reconstruct multi-agent decisions. Lifecycle is tied to the root
    -- run: ON DELETE CASCADE wipes messages when the run is purged.
    --
    -- protocol is a closed enum (see packages/server/src/enums/bus.ts).
    -- reply_to links Answer messages to their originating Question so
    -- the wait_for_response tool can resolve the right reply. The
    -- self-referential FK uses ON DELETE SET NULL because the parent
    -- message and its replies share the same root_run_id and CASCADE
    -- already collects them at the root level.
    CREATE TABLE IF NOT EXISTS agent_messages (
      id            TEXT PRIMARY KEY,
      root_run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      from_run_id   TEXT NOT NULL,
      from_agent    TEXT NOT NULL,
      protocol      TEXT NOT NULL
        CHECK (protocol IN ('status','result','help','question','answer','broadcast')),
      topic         TEXT NOT NULL,
      content       TEXT NOT NULL,
      reply_to      TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_messages_root
      ON agent_messages(root_run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_reply
      ON agent_messages(reply_to);

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
    -- scope (cross-session / cross-run org assets). Both FKs SET NULL
    -- on parent delete so logout never wipes the user's uploads — the
    -- user (owner_upn) is the durable owner.
    CREATE TABLE IF NOT EXISTS attachments (
      id              TEXT PRIMARY KEY,
      scope           TEXT NOT NULL
        CHECK (scope IN ('run','session','workspace_asset')),
      run_id          TEXT REFERENCES runs(id)     ON DELETE SET NULL,
      session_id      TEXT REFERENCES sessions(sid) ON DELETE SET NULL,
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

    -- ── Entity registry: SCD2 strategies (versioned) ─────────────
    -- Tenant-scoped registry of column-handling strategies referenced by
    -- entity definitions. Two-table pattern: scd2_strategies is the
    -- pointer (current_version + retired_at), scd2_strategy_versions
    -- is the immutable history. Update + delete on *_versions are
    -- refused by triggers below.
    CREATE TABLE IF NOT EXISTS scd2_strategies (
      tenant_id        TEXT NOT NULL,
      id               TEXT NOT NULL,
      current_version  INTEGER NOT NULL,
      retired_at       TEXT,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS scd2_strategy_versions (
      tenant_id        TEXT NOT NULL,
      id               TEXT NOT NULL,
      version          INTEGER NOT NULL,
      body_json        TEXT NOT NULL,
      created_by       TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      reason           TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tenant_id, id, version)
    );
    CREATE TRIGGER IF NOT EXISTS scd2_strategy_versions_no_update
      BEFORE UPDATE ON scd2_strategy_versions
      BEGIN SELECT RAISE(ABORT, 'scd2_strategy_versions is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS scd2_strategy_versions_no_delete
      BEFORE DELETE ON scd2_strategy_versions
      BEGIN SELECT RAISE(ABORT, 'scd2_strategy_versions is append-only'); END;
    CREATE INDEX IF NOT EXISTS idx_scd2_versions_lookup
      ON scd2_strategy_versions(tenant_id, id, version DESC);

    -- ── Entity registry: entity definitions (versioned) ──────────
    -- Same pointer + immutable history pattern. body_json is the full
    -- EntityDefinition JSON (excluding the version/version_label/etc.
    -- columns surfaced separately for indexing). diff_json is the
    -- structured diff vs the prior version produced by
    -- diffEntityDefinitions() — stored so evidence envelopes can replay
    -- exactly what the proposer saw without recomputing.
    CREATE TABLE IF NOT EXISTS entity_defs (
      tenant_id        TEXT NOT NULL,
      id               TEXT NOT NULL,
      current_version  INTEGER NOT NULL,
      retired_at       TEXT,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE TABLE IF NOT EXISTS entity_def_versions (
      tenant_id        TEXT NOT NULL,
      id               TEXT NOT NULL,
      version          INTEGER NOT NULL,
      body_json        TEXT NOT NULL,
      version_label    TEXT,
      created_by       TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      reason           TEXT NOT NULL DEFAULT '',
      diff_json        TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (tenant_id, id, version)
    );
    CREATE TRIGGER IF NOT EXISTS entity_def_versions_no_update
      BEFORE UPDATE ON entity_def_versions
      BEGIN SELECT RAISE(ABORT, 'entity_def_versions is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS entity_def_versions_no_delete
      BEFORE DELETE ON entity_def_versions
      BEGIN SELECT RAISE(ABORT, 'entity_def_versions is append-only'); END;
    CREATE INDEX IF NOT EXISTS idx_entity_defs_tenant
      ON entity_defs(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_entity_def_versions_lookup
      ON entity_def_versions(tenant_id, id, version DESC);

    -- ══════════════════════════════════════════════════════════════
    -- F1 — Reconciliation Proposer subsystem (Phase 1)
    -- ══════════════════════════════════════════════════════════════

    -- Per-pass record of a proposer scan over one env-pair. We keep
    -- counts + status here; per-finding rows live in sync_proposals.
    CREATE TABLE IF NOT EXISTS proposer_runs (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      source        TEXT NOT NULL,
      target        TEXT NOT NULL,
      started_at    TEXT NOT NULL,
      finished_at   TEXT,
      status        TEXT NOT NULL
        CHECK (status IN ('pending','running','completed','failed','cancelled')),
      scanned       INTEGER NOT NULL DEFAULT 0,
      produced      INTEGER NOT NULL DEFAULT 0,
      errors        INTEGER NOT NULL DEFAULT 0,
      duration_ms   INTEGER,
      triggered_by  TEXT NOT NULL,
      trigger       TEXT NOT NULL CHECK (trigger IN ('schedule','manual','retry')),
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_proposer_runs_pair
      ON proposer_runs(tenant_id, source, target, started_at DESC);

    -- A single divergence finding awaiting human review. Lifecycle is
    -- enforced in proposals.ts; we store status as a free TEXT here
    -- with a CHECK guarding the closed set of legal values.
    CREATE TABLE IF NOT EXISTS sync_proposals (
      id                 TEXT PRIMARY KEY,
      tenant_id          TEXT NOT NULL,
      run_id             TEXT NOT NULL REFERENCES proposer_runs(id) ON DELETE CASCADE,
      fingerprint        TEXT NOT NULL,
      source             TEXT NOT NULL,
      target             TEXT NOT NULL,
      entity_type        TEXT NOT NULL,
      entity_id          TEXT NOT NULL,
      entity_label       TEXT NOT NULL,
      kind               TEXT NOT NULL CHECK (kind IN ('drift','out_of_sync','new')),
      counts_json        TEXT NOT NULL,
      detail_json        TEXT NOT NULL,
      entity_def_version INTEGER,
      observed_at        TEXT NOT NULL,
      enqueued_at        TEXT NOT NULL DEFAULT (datetime('now')),
      status             TEXT NOT NULL
        CHECK (status IN ('open','awaiting_approval','previewed','executed','dismissed','snoozed','superseded','failed')),
      annotation_json    TEXT,
      annotation_failed_open INTEGER NOT NULL DEFAULT 0,
      risk_tier          TEXT,
      risk_score         REAL,
      rank_score         REAL,
      plan_id            TEXT,
      snooze_until       TEXT,
      superseded_by      TEXT,
      last_actor         TEXT,
      last_action        TEXT,
      last_action_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_proposals_status
      ON sync_proposals(tenant_id, status, risk_tier);
    CREATE INDEX IF NOT EXISTS idx_sync_proposals_pair
      ON sync_proposals(tenant_id, source, target, status);
    CREATE INDEX IF NOT EXISTS idx_sync_proposals_fp
      ON sync_proposals(tenant_id, fingerprint, status);

    -- Append-only audit log of proposal lifecycle transitions.
    CREATE TABLE IF NOT EXISTS sync_proposal_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id    TEXT NOT NULL REFERENCES sync_proposals(id) ON DELETE CASCADE,
      from_status    TEXT,
      to_status      TEXT NOT NULL,
      actor          TEXT NOT NULL,
      reason         TEXT NOT NULL DEFAULT '',
      detail_json    TEXT NOT NULL DEFAULT '{}',
      at             TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_proposal_history_pid
      ON sync_proposal_history(proposal_id, at DESC);
    CREATE TRIGGER IF NOT EXISTS sync_proposal_history_no_update
      BEFORE UPDATE ON sync_proposal_history
      BEGIN SELECT RAISE(ABORT, 'sync_proposal_history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS sync_proposal_history_no_delete
      BEFORE DELETE ON sync_proposal_history
      BEGIN SELECT RAISE(ABORT, 'sync_proposal_history is append-only'); END;

    -- ── Approval policies (per env, per risk tier) ──────────────
    -- One row per (tenant, target_env, risk_tier). policy is one of
    -- 'none' (no human required), 'single' (1 approver, not self),
    -- 'dual' (2 approvers, both ≠ requester and ≠ each other).
    CREATE TABLE IF NOT EXISTS approval_policies (
      tenant_id    TEXT NOT NULL,
      target_env   TEXT NOT NULL,
      risk_tier    TEXT NOT NULL CHECK (risk_tier IN ('low','medium','high','critical')),
      policy       TEXT NOT NULL CHECK (policy IN ('none','single','dual')),
      approvers_json TEXT NOT NULL DEFAULT '[]',
      bypass_role  TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by   TEXT NOT NULL,
      PRIMARY KEY (tenant_id, target_env, risk_tier)
    );

    -- ── Approval requests per proposal ──────────────────────────
    -- An approval row is created when a proposal moves to
    -- awaiting_approval. The route handlers populate granted_by_*
    -- columns as each approver acts; once policy is satisfied the
    -- proposal flips to executed (asynchronously by the runner).
    CREATE TABLE IF NOT EXISTS sync_approvals (
      id              TEXT PRIMARY KEY,
      proposal_id     TEXT NOT NULL REFERENCES sync_proposals(id) ON DELETE CASCADE,
      tenant_id       TEXT NOT NULL,
      requested_by    TEXT NOT NULL,
      requested_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at      TEXT NOT NULL,
      policy          TEXT NOT NULL CHECK (policy IN ('none','single','dual')),
      state           TEXT NOT NULL
        CHECK (state IN ('pending','partially_granted','granted','rejected','expired','bypassed','cancelled')),
      granted_by_1    TEXT,
      granted_at_1    TEXT,
      granted_by_2    TEXT,
      granted_at_2    TEXT,
      rejected_by     TEXT,
      rejected_at     TEXT,
      reject_reason   TEXT,
      bypass_by       TEXT,
      bypass_reason   TEXT,
      plan_id_at_request TEXT,
      plan_hash_at_request TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_approvals_state
      ON sync_approvals(tenant_id, state, expires_at);

    -- One-click HMAC tokens for email/chat actions. token_hash is
    -- sha256(secret || raw_token) so DB compromise does not yield
    -- usable tokens.
    CREATE TABLE IF NOT EXISTS sync_approval_tokens (
      token_hash    TEXT PRIMARY KEY,
      approval_id   TEXT NOT NULL REFERENCES sync_approvals(id) ON DELETE CASCADE,
      action        TEXT NOT NULL CHECK (action IN ('grant','reject')),
      issued_to     TEXT NOT NULL,
      issued_at     TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL,
      used_at       TEXT,
      used_by       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sync_approval_tokens_app
      ON sync_approval_tokens(approval_id);

    -- ── Evidence index (one row per envelope) ───────────────────
    -- envelope_path is relative to data/evidence/. signer_id +
    -- signature_alg let the verifier route requests to the right
    -- signer (HMAC/FILE-RSA/KMS). content_hash is the SHA-256 of the
    -- canonical JSON envelope (signature stripped).
    CREATE TABLE IF NOT EXISTS sync_evidence (
      id             TEXT PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      plan_id        TEXT NOT NULL,
      proposal_id    TEXT,
      envelope_path  TEXT NOT NULL,
      pdf_path       TEXT,
      content_hash   TEXT NOT NULL,
      signature_alg  TEXT NOT NULL,
      signer_id      TEXT NOT NULL,
      signature      TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_evidence_plan
      ON sync_evidence(tenant_id, plan_id);

    -- ── Notification routes + delivery log ──────────────────────
    CREATE TABLE IF NOT EXISTS notification_routes (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT NOT NULL,
      event_type    TEXT NOT NULL,
      filter_json   TEXT NOT NULL DEFAULT '{}',
      channel       TEXT NOT NULL CHECK (channel IN ('email','teams','slack')),
      target        TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notification_routes_ev
      ON notification_routes(tenant_id, event_type, enabled);

    CREATE TABLE IF NOT EXISTS notification_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id      TEXT REFERENCES notification_routes(id) ON DELETE SET NULL,
      event_type    TEXT NOT NULL,
      channel       TEXT NOT NULL,
      target        TEXT NOT NULL,
      payload_json  TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('sent','retrying','dlq','suppressed')),
      attempts      INTEGER NOT NULL DEFAULT 0,
      last_error    TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notification_log_status
      ON notification_log(status, created_at DESC);

    -- ── Freeze windows (per tenant; referenced from EntityPolicies.freezeWindowIds[]) ──
    -- Composite PK = (tenant_id, id). Times are ISO-8601 UTC.
    -- Evaluator semantics are [starts_at, ends_at) — start inclusive,
    -- end exclusive. Mirror is pushed into the agent's in-process
    -- registry by refreshFreezeWindowRegistry() at boot and on
    -- every upsert/delete.
    CREATE TABLE IF NOT EXISTS freeze_windows (
      tenant_id    TEXT NOT NULL,
      id           TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      starts_at    TEXT NOT NULL,
      ends_at      TEXT NOT NULL,
      created_by   TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tenant_id, id),
      CHECK (datetime(ends_at) > datetime(starts_at))
    );
    CREATE INDEX IF NOT EXISTS idx_freeze_windows_tenant_starts
      ON freeze_windows(tenant_id, starts_at);

    -- ── Proposer schedule (per env-pair) ────────────────────────
    CREATE TABLE IF NOT EXISTS proposer_schedule (
      tenant_id     TEXT NOT NULL,
      source        TEXT NOT NULL,
      target        TEXT NOT NULL,
      cron          TEXT NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      last_run_at   TEXT,
      next_run_at   TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by    TEXT NOT NULL,
      PRIMARY KEY (tenant_id, source, target)
    );
  `)

  // Historical builds forced admin actions into a fake `__admin__` run to
  // satisfy the `audit_log.run_id -> runs.id` foreign key. Migrate that
  // shape away on boot so admin audit stops polluting the run namespace.
  migrateAuditLogScopes(db)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_scope ON audit_log(scope_type, scope_id, timestamp DESC);`)

  // v23: switch every session_id FK from CASCADE to SET NULL so that
  // logging out (DELETE FROM sessions) does not cascade-wipe the user's
  // runs/attachments/memories/notifications. Idempotent — a no-op once
  // the tables are already on the new schema. Memory + notification
  // tables are created lazily by their own modules; the migration only
  // touches whichever of the five target tables already exist here, and
  // each module's own init also calls migrateSessionFkSetNull so a fresh
  // boot fixes them in any order.
  migrateSessionFkSetNull(db)

  // ── Seed bundled SCD2 strategies into the `_default` tenant ─────
  // Idempotent: only inserts strategies that don't already exist. We
  // never UPDATE existing rows — bumping a bundled strategy requires a
  // new version number which inserts a new row in scd2_strategy_versions
  // and advances the pointer. The default tenant id matches
  // DEFAULT_TENANT_ID exported from @mia/agent.
  const seedStrategyPointer = db.prepare(
    `INSERT OR IGNORE INTO scd2_strategies (tenant_id, id, current_version, retired_at)
     VALUES (?, ?, ?, NULL)`,
  )
  const seedStrategyVersion = db.prepare(
    `INSERT OR IGNORE INTO scd2_strategy_versions
       (tenant_id, id, version, body_json, created_by, created_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const s of BUNDLED_SCD2_STRATEGIES) {
    seedStrategyPointer.run("_default", s.id, s.version)
    seedStrategyVersion.run(
      "_default",
      s.id,
      s.version,
      JSON.stringify(s),
      s.createdBy,
      s.createdAt,
      "bundled",
    )
  }

  // Seed default agent (no `tools` column anymore).
  //
  // CONTRACT: the default ("Universal") agent's `system_prompt` column is
  // NOT a source of truth — it is a display-only mirror of the live file
  // `packages/agent/prompts/default-system.md` (DEFAULT_SYSTEM_PROMPT).
  //
  // History: this column used to be operator-editable via PUT /api/agents/:id
  // and was only bumped on schema-version changes via an `isKnownOldSeedPrompt`
  // legacy-string check. The result was that any operator edit, or any file
  // change without a SCHEMA_VERSION bump, made the DB row diverge from the
  // file forever — and because run-executor reads from the DB row, the live
  // prompt file became dead code for all existing installs.
  //
  // The fix has three layers (defense in depth):
  //   1. (here)         Always overwrite this row on every startup.
  //   2. (routes/agents.ts)   Reject PUT to "default" that changes systemPrompt.
  //   3. (run-executor.ts)    Ignore the stored value at runtime — always use
  //                           DEFAULT_SYSTEM_PROMPT when agentId === "default".
  // Custom agents (any non-"default" id) keep DB persistence — that is the
  // entire point of letting operators fork a prompt.
  const seededDefaultSha = createHash("sha1").update(DEFAULT_SYSTEM_PROMPT).digest("hex").slice(0, 8)
  const previousDefault = db.prepare(
    "SELECT system_prompt FROM agent_definitions WHERE id = 'default'",
  ).get() as { system_prompt: string } | undefined
  db.prepare(`
    INSERT INTO agent_definitions (id, name, description, system_prompt, created_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      system_prompt = excluded.system_prompt,
      name          = excluded.name,
      description   = excluded.description,
      updated_at    = datetime('now')
  `).run(
    "default",
    "Universal Agent",
    "General-purpose agent with all tools. Handles any task.",
    DEFAULT_SYSTEM_PROMPT,
  )
  if (previousDefault && previousDefault.system_prompt !== DEFAULT_SYSTEM_PROMPT) {
    const previousSha = createHash("sha1").update(previousDefault.system_prompt).digest("hex").slice(0, 8)
    // eslint-disable-next-line no-console
    console.log(
      `[seed] default agent system_prompt re-synced from file: ${previousSha} → ${seededDefaultSha} ` +
      `(${DEFAULT_SYSTEM_PROMPT.length} bytes). Source: packages/agent/prompts/default-system.md`,
    )
  } else {
    // eslint-disable-next-line no-console
    console.log(`[seed] default agent system_prompt verified (sha=${seededDefaultSha}, ${DEFAULT_SYSTEM_PROMPT.length} bytes)`)
  }

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

  // NOTE: the system_prompt re-sync for the "default" agent above runs on
  // EVERY startup (unconditional). The version-gated bump below is kept ONLY
  // for the seed_version bookkeeping — there is nothing left for it to do for
  // the default prompt, and it never touched custom agents.
  if (currentSeedVersion < SEED_VERSION) {
    setMetaValue("seed_version", String(SEED_VERSION))
  }
}
