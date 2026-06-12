/**
 * Tests for loadPriorTurns — thread-scoped cross-turn grounding.
 */

import Database from "better-sqlite3"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  loadPriorTurns,
  PRIOR_TURN_ANSWER_MAX_CHARS
} from "../src/features/runs/core/data-blocks/prior-turns.js"
import { seedSession, seedUser } from "./_fk-helpers.js"

let db: Database.Database
let dataDir: string
let originalDataDir: string | undefined

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "mia-prior-turns-"))
  originalDataDir = process.env["MIA_DATA_DIR"]
  process.env["MIA_DATA_DIR"] = dataDir
  db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  const { _setDb, _migrate } = await import("../src/platform/persistence/db/index.js")
  _setDb(db)
  _migrate(db)
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* already closed */
  }
  rmSync(dataDir, { recursive: true, force: true })
  if (originalDataDir === undefined) delete process.env["MIA_DATA_DIR"]
  else process.env["MIA_DATA_DIR"] = originalDataDir
})

const SID = "anon:0123456789abcdef0123456789abcdef"
const UPN = "alice@example.com"
const THREAD_ID = "11111111-1111-4111-8111-111111111111"
const OTHER_THREAD_ID = "22222222-2222-4222-8222-222222222222"

function seedThread(id: string, upn: string): void {
  seedUser(db, upn)
  db.prepare(
    `
    INSERT OR IGNORE INTO threads (id, upn, title, created_at, updated_at, archived_at, pinned)
    VALUES (@id, @upn, 'Test thread', datetime('now'), datetime('now'), NULL, 0)
  `
  ).run({ id, upn })
}

interface InsertRun {
  id: string
  goal: string
  answer?: string | null
  status?: string
  completedMinutesAgo?: number
  parentRunId?: string | null
  sessionId?: string
  upn?: string
  threadId?: string
}

function insertRun(r: InsertRun): void {
  const sid = r.sessionId ?? SID
  const upn = r.upn ?? UPN
  const threadId = r.threadId ?? THREAD_ID
  seedThread(threadId, upn)
  seedSession(db, sid, upn)
  const completedAt =
    r.completedMinutesAgo == null ? null : new Date(Date.now() + r.completedMinutesAgo * 60_000).toISOString()
  const createdAt = completedAt ?? new Date(Date.now() + (r.completedMinutesAgo ?? 0) * 60_000).toISOString()
  db.prepare(
    `
    INSERT INTO runs (id, goal, status, answer, step_count, error, parent_run_id, agent_id, created_at, completed_at, session_id, thread_id, upn, display_name)
    VALUES (@id, @goal, @status, @answer, 1, NULL, @parent_run_id, NULL, @created_at, @completed_at, @session_id, @thread_id, @upn, @display_name)
  `
  ).run({
    display_name: upn ?? "anon",
    id: r.id,
    goal: r.goal,
    status: r.status ?? "completed",
    answer: r.answer ?? null,
    parent_run_id: r.parentRunId ?? null,
    created_at: createdAt,
    completed_at: completedAt,
    session_id: sid,
    thread_id: threadId,
    upn
  })
}

describe("loadPriorTurns", () => {
  it("returns most-recent runs first, capped by limit", () => {
    insertRun({ id: "r1", goal: "first", answer: "A1", completedMinutesAgo: -30 })
    insertRun({ id: "r2", goal: "second", answer: "A2", completedMinutesAgo: -20 })
    insertRun({ id: "r3", goal: "third", answer: "A3", completedMinutesAgo: -10 })
    insertRun({ id: "r4", goal: "fourth", answer: "A4", completedMinutesAgo: -5 })

    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN, limit: 3 })

    expect(turns.map((t) => t.runId)).toEqual(["r4", "r3", "r2"])
    expect(turns[0]?.goal).toBe("fourth")
    expect(turns[0]?.answer).toBe("A4")
  })

  it("excludes the current runId via excludeRunId", () => {
    insertRun({ id: "rPrev", goal: "earlier", answer: "old", completedMinutesAgo: -10 })
    insertRun({ id: "rCur", goal: "current", answer: "new", completedMinutesAgo: -1 })

    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN, excludeRunId: "rCur" })

    expect(turns.map((t) => t.runId)).toEqual(["rPrev"])
  })

  it("filters strictly by threadId", () => {
    insertRun({ id: "rA", goal: "in-thread", answer: "yes", completedMinutesAgo: -5, threadId: THREAD_ID })
    insertRun({
      id: "rB",
      goal: "other-thread",
      answer: "no",
      completedMinutesAgo: -3,
      threadId: OTHER_THREAD_ID
    })

    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN })

    expect(turns.map((t) => t.runId)).toEqual(["rA"])
  })

  it("filters strictly by upn (tenant isolation)", () => {
    insertRun({ id: "rMine", goal: "mine", answer: "ok", completedMinutesAgo: -5, upn: UPN })
    insertRun({
      id: "rOther",
      goal: "other",
      answer: "ok",
      completedMinutesAgo: -3,
      upn: "bob@example.com",
      threadId: OTHER_THREAD_ID
    })

    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN })

    expect(turns.map((t) => t.runId)).toEqual(["rMine"])
  })

  it("returns [] when upn is empty", () => {
    insertRun({ id: "rX", goal: "x", answer: "x", completedMinutesAgo: -1 })
    expect(loadPriorTurns({ threadId: THREAD_ID, upn: "" })).toEqual([])
  })

  it("skips delegated child runs (parent_run_id IS NOT NULL)", () => {
    insertRun({ id: "rParent", goal: "top-level", answer: "P", completedMinutesAgo: -10 })
    insertRun({
      id: "rChild",
      goal: "delegated",
      answer: "C",
      completedMinutesAgo: -5,
      parentRunId: "rParent"
    })

    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN })

    expect(turns.map((t) => t.runId)).toEqual(["rParent"])
  })

  it("skips non-terminal and cancelled/crashed statuses", () => {
    insertRun({ id: "rOk", goal: "ok", answer: "x", completedMinutesAgo: -50, status: "completed" })
    insertRun({ id: "rFail", goal: "failed", answer: "y", completedMinutesAgo: -40, status: "failed" })
    insertRun({
      id: "rRunning",
      goal: "running",
      answer: null,
      completedMinutesAgo: -30,
      status: "running"
    })
    insertRun({
      id: "rCancelled",
      goal: "cancelled",
      answer: null,
      completedMinutesAgo: -20,
      status: "cancelled"
    })
    insertRun({
      id: "rCrashed",
      goal: "crashed",
      answer: null,
      completedMinutesAgo: -10,
      status: "crashed"
    })

    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN, limit: 10 })

    expect(turns.map((t) => t.runId).sort()).toEqual(["rFail", "rOk"])
  })

  it("truncates long answers at a boundary with a suffix", () => {
    const longAnswer = "line\n".repeat(PRIOR_TURN_ANSWER_MAX_CHARS / 5 + 200)
    insertRun({ id: "rBig", goal: "big", answer: longAnswer, completedMinutesAgo: -1 })

    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN })

    expect(turns).toHaveLength(1)
    const a = turns[0]!.answer!
    expect(a.length).toBeLessThanOrEqual(PRIOR_TURN_ANSWER_MAX_CHARS + 32)
    expect(a).toMatch(/\[truncated\]/)
  })

  it("preserves null answers as null (e.g. failed runs)", () => {
    insertRun({ id: "rNull", goal: "null-ans", answer: null, completedMinutesAgo: -1, status: "failed" })

    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN })

    expect(turns[0]?.answer).toBeNull()
  })

  it("returns [] when threadId is empty", () => {
    insertRun({ id: "rX", goal: "x", answer: "x", completedMinutesAgo: -1 })
    expect(loadPriorTurns({ threadId: "", upn: UPN })).toEqual([])
  })

  it("returns [] when limit <= 0", () => {
    insertRun({ id: "rX", goal: "x", answer: "x", completedMinutesAgo: -1 })
    expect(loadPriorTurns({ threadId: THREAD_ID, upn: UPN, limit: 0 })).toEqual([])
  })

  it("ranAt uses completed_at when present, falls back to created_at", () => {
    insertRun({ id: "rDone", goal: "done", answer: "x", completedMinutesAgo: -1 })
    const turns = loadPriorTurns({ threadId: THREAD_ID, upn: UPN })
    expect(turns[0]?.ranAt).toBeTruthy()
  })
})
