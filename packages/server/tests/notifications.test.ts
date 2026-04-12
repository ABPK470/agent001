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
    migrateNotifications,
    saveNotification,
    type DbNotification,
} from "../src/db.js"

// ── Helper: in-memory DB ─────────────────────────────────────────

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
  _setDb(testDb)
  _migrate(testDb)
  migrateNotifications()
})

afterEach(() => {
  testDb.close()
})

function insertRun(id: string, status: string, goal = "test goal") {
  testDb.prepare(
    "INSERT INTO runs (id, goal, status, created_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(id, goal, status)
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
    ...overrides,
  }
}

// ── Notification CRUD ────────────────────────────────────────────

describe("Notifications", () => {
  it("saves and lists notifications", () => {
    const n = makeNotification({ id: "n1", title: "First" })
    saveNotification(n)

    const list = listNotifications()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe("n1")
    expect(list[0].title).toBe("First")
    expect(list[0].read).toBe(0)
  })

  it("lists in reverse chronological order", () => {
    saveNotification(makeNotification({ id: "old", created_at: "2024-01-01T00:00:00Z" }))
    saveNotification(makeNotification({ id: "new", created_at: "2025-01-01T00:00:00Z" }))

    const list = listNotifications()
    expect(list[0].id).toBe("new")
    expect(list[1].id).toBe("old")
  })

  it("respects limit parameter", () => {
    for (let i = 0; i < 5; i++) {
      saveNotification(makeNotification({ id: `n${i}` }))
    }
    expect(listNotifications(3)).toHaveLength(3)
    expect(listNotifications()).toHaveLength(5)
  })

  it("marks a single notification as read", () => {
    saveNotification(makeNotification({ id: "n1" }))
    expect(listNotifications()[0].read).toBe(0)

    markNotificationRead("n1")
    expect(listNotifications()[0].read).toBe(1)
  })

  it("marks all notifications as read", () => {
    saveNotification(makeNotification({ id: "n1" }))
    saveNotification(makeNotification({ id: "n2" }))
    expect(getUnreadNotificationCount()).toBe(2)

    markAllNotificationsRead()
    expect(getUnreadNotificationCount()).toBe(0)
    expect(listNotifications().every((n) => n.read === 1)).toBe(true)
  })

  it("counts unread notifications", () => {
    saveNotification(makeNotification({ id: "n1", read: 0 }))
    saveNotification(makeNotification({ id: "n2", read: 0 }))
    saveNotification(makeNotification({ id: "n3", read: 1 }))

    expect(getUnreadNotificationCount()).toBe(2)
  })

  it("upserts on duplicate id", () => {
    saveNotification(makeNotification({ id: "n1", title: "Original" }))
    saveNotification(makeNotification({ id: "n1", title: "Updated" }))

    const list = listNotifications()
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("Updated")
  })
})

// ── Stale runs recovery ──────────────────────────────────────────

describe("Stale runs", () => {
  it("finds running/pending/planning runs as stale", () => {
    insertRun("r1", "running")
    insertRun("r2", "pending")
    insertRun("r3", "planning")
    insertRun("r4", "completed")
    insertRun("r5", "failed")

    const stale = findStaleRuns()
    const staleIds = stale.map((r) => r.id)
    expect(staleIds).toContain("r1")
    expect(staleIds).toContain("r2")
    expect(staleIds).toContain("r3")
    expect(staleIds).not.toContain("r4")
    expect(staleIds).not.toContain("r5")
  })

  it("marks a run as crashed with error message", () => {
    insertRun("r1", "running")
    markRunCrashed("r1")

    const row = testDb.prepare("SELECT * FROM runs WHERE id = ?").get("r1") as Record<string, unknown>
    expect(row.status).toBe("failed")
    expect(row.error).toContain("Server restarted")
    expect(row.completed_at).not.toBeNull()
  })

  it("returns empty array when no stale runs exist", () => {
    insertRun("r1", "completed")
    expect(findStaleRuns()).toHaveLength(0)
  })
})
