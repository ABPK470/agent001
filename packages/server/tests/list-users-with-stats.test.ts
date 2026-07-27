/**
 * Active Users aggregates must join runs/token_usage by lower(upn).
 * Users are canonical-lowercased; legacy runs may still be mixed-case.
 */

import Database from "better-sqlite3"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { _migrate, _setDb, listUserHistory, listUsersWithStats, saveRun, saveTokenUsage } from "../src/infra/persistence/db/index.js"
import { seedSession, seedUser } from "./_fk-helpers.js"

const CANONICAL = "alice@example.com"
const LEGACY_CASE = "Alice@Example.com"

let testDb: Database.Database

beforeEach(() => {
  testDb = new Database(":memory:")
  testDb.pragma("journal_mode = WAL")
  testDb.pragma("foreign_keys = ON")
  _setDb(testDb)
  _migrate(testDb)
})

afterEach(() => {
  testDb.close()
})

function insertLegacyCasedRun(runId: string): void {
  seedUser(testDb, CANONICAL, { displayName: "Alice" })
  seedSession(testDb, "sid-alice", CANONICAL)
  // Legacy mismatch: run.upn casing differs from users.upn (FK off for insert).
  testDb.pragma("foreign_keys = OFF")
  testDb
    .prepare(
      `INSERT INTO runs (id, goal, status, upn, display_name, created_at)
       VALUES (?, 'goal', 'completed', ?, 'Alice', datetime('now'))`
    )
    .run(runId, LEGACY_CASE)
  testDb.pragma("foreign_keys = ON")
  saveTokenUsage({
    run_id: runId,
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    llm_calls: 3,
    model: "test-model",
    created_at: new Date().toISOString(),
  })
}

describe("listUsersWithStats", () => {
  it("attributes tokens and LLM calls when run UPN casing differs from users", () => {
    insertLegacyCasedRun("run-mixed")

    const rows = listUsersWithStats({ sinceSeconds: 604_800, activityWindowSeconds: 86_400 })
    const alice = rows.find((r) => r.upn === CANONICAL)
    expect(alice).toBeDefined()
    expect(alice!.totalRuns).toBe(1)
    expect(alice!.runs24h).toBe(1)
    expect(alice!.totalTokens24h).toBe(150)
    expect(alice!.totalLlmCalls24h).toBe(3)
    expect(alice!.lastModel).toBe("test-model")
  })

  it("lists history for mixed-case run UPNs under the canonical identifier", () => {
    insertLegacyCasedRun("run-hist")

    const { runs, total } = listUserHistory(CANONICAL, 25, 0)
    expect(total).toBe(1)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.totalTokens).toBe(150)
    expect(runs[0]!.llmCalls).toBe(3)
  })

  it("lowercases UPN on saveRun so new writes stay canonical", () => {
    seedUser(testDb, CANONICAL)
    saveRun({
      id: "run-new",
      goal: "g",
      status: "completed",
      answer: null,
      step_count: 0,
      upn: LEGACY_CASE,
      display_name: "Alice",
      thread_id: null,
      parent_run_id: null,
      error: null,
      created_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
    })
    const row = testDb.prepare("SELECT upn FROM runs WHERE id = ?").get("run-new") as { upn: string }
    expect(row.upn).toBe(CANONICAL)
  })
})
