/**
 * Migration runner — fresh DB, idempotency.
 */

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _migrate, _setDb } from "../src/infra/persistence/connection.js"
import { listMigrations, MIGRATIONS, runMigrations } from "../src/infra/persistence/migrations/index.js"

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

    expect(testDb.prepare("SELECT id FROM agent_definitions WHERE id='default'").get()).toBeTruthy()
    expect(testDb.prepare("SELECT name FROM sqlite_master WHERE name='notifications'").get()).toBeTruthy()
  })
})
