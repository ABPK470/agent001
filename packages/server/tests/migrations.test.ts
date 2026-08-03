/**
 * Migration runner — fresh DB, idempotency.
 */

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _migrate, _setDb } from "../src/infra/persistence/adapters/sqlite/connection.js"
import { listMigrations, MIGRATIONS, runMigrations } from "../src/infra/persistence/adapters/sqlite/migrations/index.js"

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(":memory:")
  testDb.pragma("foreign_keys = ON")
  _setDb(testDb)
})

afterEach(() => {
  testDb.close()
})

describe("runMigrations", () => {
  it("applies all migrations on a fresh database", () => {
    runMigrations(testDb)

    const status = listMigrations(testDb)
    expect(status.every((m) => m.applied_at !== null)).toBe(true)
    expect(status).toHaveLength(MIGRATIONS.length)

    expect(testDb.prepare("SELECT name FROM sqlite_master WHERE name='threads'").get()).toBeTruthy()
    const runsCols = testDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>
    expect(runsCols.some((c) => c.name === "thread_id")).toBe(true)

    expect(runsCols.some((c) => c.name === "session_id")).toBe(false)

    const convCols = testDb.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>
    expect(convCols.some((c) => c.name === "thread_id")).toBe(true)

    const threadCols = testDb.prepare("PRAGMA table_info(threads)").all() as Array<{ name: string }>
    expect(threadCols.some((c) => c.name === "kind")).toBe(false)

    const attachSql = (
      testDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'").get() as {
        sql: string
      }
    ).sql
    expect(attachSql).toContain("'user_draft'")
    expect(attachSql).not.toContain("'session'")

    expect(
      testDb.prepare("SELECT name FROM sqlite_master WHERE name='sync_catalog_versions'").get(),
    ).toBeTruthy()

    // Baseline terminal shape: no agent_configs / runs.agent_id; eval dataset present.
    expect(testDb.prepare("SELECT name FROM sqlite_master WHERE name='agent_configs'").get()).toBeFalsy()
    expect(runsCols.some((c) => c.name === "agent_id")).toBe(false)
    expect(
      testDb.prepare("SELECT name FROM sqlite_master WHERE name='eval_dataset_entries'").get(),
    ).toBeTruthy()
    // Retired Playwright stack — never created on fresh DB; dropped by v2 if leftover.
    for (const name of [
      "browser_contexts",
      "browser_credentials",
      "browser_proxy_config",
      "browser_domain_policy_configs",
      "browser_audit_log",
    ]) {
      expect(testDb.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name)).toBeFalsy()
    }
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 6])
  })

  it("drops leftover browser tables on upgrade (v6)", () => {
    testDb.exec(`
      CREATE TABLE browser_contexts (id TEXT PRIMARY KEY);
      CREATE TABLE browser_credentials (id TEXT PRIMARY KEY);
      CREATE TABLE browser_proxy_config (owner_upn TEXT PRIMARY KEY);
      CREATE TABLE browser_domain_policy_configs (id TEXT PRIMARY KEY);
      CREATE TABLE browser_audit_log (id INTEGER PRIMARY KEY);
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      INSERT INTO schema_migrations VALUES (1, 'baseline', datetime('now'));
    `)
    runMigrations(testDb)
    for (const name of [
      "browser_contexts",
      "browser_credentials",
      "browser_proxy_config",
      "browser_domain_policy_configs",
      "browser_audit_log",
    ]) {
      expect(testDb.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name)).toBeFalsy()
    }
    expect(
      (
        testDb.prepare("SELECT name FROM schema_migrations WHERE version = 6").get() as {
          name: string
        }
      ).name,
    ).toBe("drop_browser_tables")
  })

  it("is idempotent across repeated runs", () => {
    runMigrations(testDb)
    runMigrations(testDb)
    runMigrations(testDb)

    const count = (
      testDb.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get() as { c: number }
    ).c
    expect(count).toBe(MIGRATIONS.length)
  })

  it("_migrate runs migrations and seeds", () => {
    _migrate(testDb)

    expect(testDb.prepare("SELECT name FROM sqlite_master WHERE name='notifications'").get()).toBeTruthy()
  })
})
