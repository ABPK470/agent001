#!/usr/bin/env node
/**
 * wipe-operational-data.mjs
 *
 * Truncates rows from the local MIA SQLite DB for tables that hold transient
 * / operational run data (runs, chat messages, memories, tool-knowledge cache,
 * logs, notifications, attachments, browser contexts, checkpoints, effects,
 * sync proposals / approvals / audit, event log, etc.).
 *
 * NEVER touches config / true metadata tables (users, agent_definitions,
 * llm_config, layouts, policy_rules, entity_defs/versions, scd2 strategies,
 * approval_policies, notification_routes, browser credentials / proxy /
 * domain policy, freeze_windows, channel_configs, schema_meta).
 *
 * Usage:
 *   node scripts/wipe-operational-data.mjs                # dry-run (default)
 *   node scripts/wipe-operational-data.mjs --yes          # actually delete
 *   node scripts/wipe-operational-data.mjs --yes --vacuum # delete + reclaim
 *   node scripts/wipe-operational-data.mjs --db /path/mia.db --yes
 *
 * The script:
 *   • resolves the DB path via --db or MIA_DATA_DIR or ~/.mia/mia.db
 *   • prints row counts before and after
 *   • warns about any unknown tables (not in WIPE or KEEP) and leaves them alone
 *   • runs inside a single transaction with foreign_keys=OFF for safety
 */

import Database from "better-sqlite3"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ── Table classification ──────────────────────────────────────────
// Anything here gets DELETE FROM. Add new operational tables here.
const WIPE = new Set([
  // Runs / orchestration
  "runs",
  "agent_messages",
  "checkpoints",
  "trace_entries",
  "token_usage",
  "logs",
  "audit_log",
  "audit_log_v22",
  "sessions",
  // Memory + caches
  // NOTE: memory_entries_fts / procedural_fts are external-content FTS5
  // indexes synced via AFTER INSERT/UPDATE/DELETE triggers on the base
  // tables. Do NOT wipe them directly — that corrupts the index and the
  // next trigger fires SQLITE_CORRUPT_VTAB. Deleting from the base tables
  // below fans out to the FTS via triggers automatically.
  "memory_entries",
  "memory_vectors",
  "procedural_memories",
  "tool_knowledge",
  // Attachments
  "attachments",
  "attachment_tags",
  "attachment_imports",
  // Notifications (log only — routes are config and stay)
  "notifications",
  "notification_log",
  // Browser (contexts / audit only — credentials / proxy / domain policy are config)
  "browser_contexts",
  "browser_audit_log",
  // Effects / file snapshots
  "effects",
  "file_snapshots",
  // Sync workflow run data (overrides / strategies / entity defs / approval policies stay)
  "sync_runs",
  "sync_audit",
  "sync_proposals",
  "sync_proposal_history",
  "sync_approvals",
  "sync_approval_tokens",
  "sync_evidence",
  "proposer_runs",
  "proposer_schedule",
  // Eventing / webhooks
  "event_log",
  "webhook_drains",
  // API request log
  "api_requests",
  // Channels (outbound conversations / delivery attempts — channel_configs stays)
  "conversations",
  "outbound_messages",
  "delivery_attempts",
])

// Anything here is config / true metadata and MUST NOT be wiped.
const KEEP = new Set([
  "schema_meta",
  "users",
  "llm_config",
  "agent_definitions",
  "layouts",
  "policy_rules",
  "sync_environment_overrides",
  "browser_credentials",
  "browser_proxy_config",
  "browser_domain_policy",
  "scd2_strategies",
  "scd2_strategy_versions",
  "entity_defs",
  "entity_def_versions",
  "approval_policies",
  "notification_routes",
  "freeze_windows",
  "channel_configs",
])

// ── CLI ───────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const yes = args.includes("--yes") || args.includes("-y")
const vacuum = args.includes("--vacuum")
const dbFlagIdx = args.findIndex((a) => a === "--db")
const dbOverride = dbFlagIdx >= 0 ? args[dbFlagIdx + 1] : null

function resolveDbPath() {
  if (dbOverride) return dbOverride
  const dir = process.env.MIA_DATA_DIR || join(homedir(), ".mia")
  return join(dir, "mia.db")
}

const dbPath = resolveDbPath()
if (!existsSync(dbPath)) {
  console.error(`✖ DB not found at ${dbPath}`)
  process.exit(1)
}

console.log(`DB: ${dbPath}`)
console.log(`Mode: ${yes ? "WIPE (--yes)" : "DRY-RUN (pass --yes to actually delete)"}`)
console.log("")

const db = new Database(dbPath)

// Discover every base table that actually exists in the DB.
const existing = db
  .prepare(
    `SELECT name FROM sqlite_master
      WHERE type IN ('table')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  )
  .all()
  .map((r) => r.name)

// FTS5 shadow tables (e.g. memory_entries_fts_data) — internal storage,
// never touch directly.
const isFtsShadow = (n) => /_fts_(data|idx|content|docsize|config|segments|segdir)$/.test(n)

// FTS5 virtual tables themselves — auto-managed by AFTER INSERT/UPDATE/DELETE
// triggers on their base content tables; wiping them directly corrupts the
// index (SQLITE_CORRUPT_VTAB). We rebuild them after the base-table wipe.
const FTS_VIRTUAL = new Set(["memory_entries_fts", "procedural_fts"])

const tablesToWipe = []
const tablesToKeep = []
const unknown = []
for (const name of existing) {
  if (isFtsShadow(name)) continue
  if (FTS_VIRTUAL.has(name)) continue // handled via base-table triggers + rebuild
  if (WIPE.has(name)) tablesToWipe.push(name)
  else if (KEEP.has(name)) tablesToKeep.push(name)
  else unknown.push(name)
}

function rowCount(table) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()
    return row.n
  } catch (e) {
    return `err: ${e.message}`
  }
}

console.log("── Tables to WIPE ────────────────────────────────")
for (const t of tablesToWipe) console.log(`  ${t.padEnd(32)} rows=${rowCount(t)}`)
if (tablesToWipe.length === 0) console.log("  (none)")

console.log("\n── Tables to KEEP (config / metadata) ───────────")
for (const t of tablesToKeep) console.log(`  ${t.padEnd(32)} rows=${rowCount(t)}`)
if (tablesToKeep.length === 0) console.log("  (none)")

if (unknown.length > 0) {
  console.log("\n── UNKNOWN tables (left untouched — review & classify) ─")
  for (const t of unknown) console.log(`  ${t.padEnd(32)} rows=${rowCount(t)}`)
}

if (!yes) {
  console.log("\nDry-run only. Re-run with --yes to actually delete.")
  db.close()
  process.exit(0)
}

// ── Wipe ──────────────────────────────────────────────────────────
console.log("\nWiping…")
db.pragma("foreign_keys = OFF")
const tx = db.transaction(() => {
  for (const t of tablesToWipe) {
    const info = db.prepare(`DELETE FROM "${t}"`).run()
    console.log(`  ✓ ${t.padEnd(32)} deleted=${info.changes}`)
    // Reset AUTOINCREMENT counters if the table uses them.
    try {
      db.prepare(`DELETE FROM sqlite_sequence WHERE name = ?`).run(t)
    } catch { /* sqlite_sequence may not exist; ignore */ }
  }
})
tx()
db.pragma("foreign_keys = ON")

// Rebuild FTS5 shadow indexes from their (now empty) content tables.
// This is the SQLite-blessed way to resync an external-content FTS5 index
// and guarantees we're in a consistent state regardless of trigger history.
for (const fts of ["memory_entries_fts", "procedural_fts"]) {
  try {
    db.prepare(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`).run()
    console.log(`  ✓ ${fts.padEnd(32)} rebuilt`)
  } catch (e) {
    console.warn(`  ⚠ ${fts} rebuild skipped: ${e.message}`)
  }
}

if (vacuum) {
  console.log("\nVACUUM…")
  db.exec("VACUUM")
}

console.log("\nDone. Final counts:")
for (const t of tablesToWipe) console.log(`  ${t.padEnd(32)} rows=${rowCount(t)}`)
db.close()
