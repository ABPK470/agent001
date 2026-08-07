/**
 * Tests for notifications DB layer and stale-run recovery.
 */

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  _migrate,
  _setDb,
  findStaleRuns,
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markRunCrashed,
  saveNotification,
  type DbNotification
} from "../src/infra/persistence/adapters/sqlite/index.js"
import { seedSession, seedUser } from "./_fk-helpers.js"

// ── Helper: in-memory DB ─────────────────────────────────────────

const TEST_UPN = "test-user@local"

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
  _setDb(testDb)
  _migrate(testDb)
  seedUser(testDb, TEST_UPN)
})

afterEach(() => {
  testDb.close()
})

function insertRun(id: string, status: string, goal = "test goal") {
  seedSession(testDb, "test-session", TEST_UPN)
  testDb
    .prepare(
      "INSERT INTO runs (id, goal, status, upn, display_name, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    )
    .run(id, goal, status, TEST_UPN, TEST_UPN)
}

function makeNotification(overrides: Partial<DbNotification> = {}): DbNotification {
  return {
    id: `n-${Math.random().toString(36).slice(2, 8)}`,
    type: "run.failed",
    title: "Test Notification",
    message: "Something happened",
    run_id: null,
    step_id: null,
    actions: "[]",
    read: 0,
    created_at: new Date().toISOString(),
    owner_upn: TEST_UPN,
    ...overrides
  }
}

// ── Notification CRUD ────────────────────────────────────────────

describe("Notifications", () => {
  it("saves and lists notifications", async () => {
    const n = makeNotification({ id: "n1", title: "First" })
    await saveNotification(n)

    const list = await listNotifications()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe("n1")
    expect(list[0].title).toBe("First")
    expect(list[0].read).toBe(0)
  })

  it("lists in reverse chronological order", async () => {
    await saveNotification(makeNotification({ id: "old", created_at: "2024-01-01T00:00:00Z" }))
    await saveNotification(makeNotification({ id: "new", created_at: "2025-01-01T00:00:00Z" }))

    const list = await listNotifications()
    expect(list[0].id).toBe("new")
    expect(list[1].id).toBe("old")
  })

  it("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      await saveNotification(makeNotification({ id: `n${i}` }))
    }
    expect(await listNotifications(3)).toHaveLength(3)
    expect(await listNotifications()).toHaveLength(5)
  })

  it("marks a single notification as read", async () => {
    await saveNotification(makeNotification({ id: "n1" }))
    expect((await listNotifications())[0].read).toBe(0)

    await markNotificationRead("n1")
    expect((await listNotifications())[0].read).toBe(1)
  })

  it("marks all notifications as read", async () => {
    await saveNotification(makeNotification({ id: "n1" }))
    await saveNotification(makeNotification({ id: "n2" }))
    expect(await getUnreadNotificationCount()).toBe(2)

    await markAllNotificationsRead()
    expect(await getUnreadNotificationCount()).toBe(0)
    expect((await listNotifications()).every((n) => n.read === 1)).toBe(true)
  })

  it("counts unread notifications", async () => {
    await saveNotification(makeNotification({ id: "n1", read: 0 }))
    await saveNotification(makeNotification({ id: "n2", read: 0 }))
    await saveNotification(makeNotification({ id: "n3", read: 1 }))

    expect(await getUnreadNotificationCount()).toBe(2)
  })

  it("upserts on duplicate id", async () => {
    await saveNotification(makeNotification({ id: "n1", title: "Original" }))
    await saveNotification(makeNotification({ id: "n1", title: "Updated" }))

    const list = await listNotifications()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("Updated")
  })
})

// ── Stale runs recovery ──────────────────────────────────────────

describe("Stale runs", () => {
  it("finds running/pending/planning runs as stale", async () => {
    insertRun("r1", "running")
    insertRun("r2", "pending")
    insertRun("r3", "planning")
    insertRun("r4", "completed")
    insertRun("r5", "failed")

    const stale = await findStaleRuns()
    const staleIds = stale.map((r) => r.id)
    expect(staleIds).toContain("r1")
    expect(staleIds).toContain("r2")
    expect(staleIds).toContain("r3")
    expect(staleIds).not.toContain("r4")
    expect(staleIds).not.toContain("r5")
  })

  it("marks a run as crashed with error message", async () => {
    insertRun("r1", "running")
    await markRunCrashed("r1")

    const row = testDb.prepare("SELECT * FROM runs WHERE id = ?").get("r1") as Record<string, unknown>
    // 'crashed' is a first-class terminal status distinct from 'failed' so
    // the UI can label server-restart interruptions separately from
    // agent-level errors. See packages/shared-enums/src/run.ts.
    expect(row.status).toBe("crashed")
    expect(row.error).toContain("Server restarted")
    expect(row.completed_at).not.toBeNull()
  })

  it("returns empty array when no stale runs exist", async () => {
    insertRun("r1", "completed")
    expect(await findStaleRuns()).toHaveLength(0)
  })
})
