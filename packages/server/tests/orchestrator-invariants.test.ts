/**
 * Layer C — logical invariant tests for thread-scoped continuity.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildFixture, DEFAULT_THREAD, salientAnswer, type TurnInputs } from "./helpers/orchestrator-fixture.js"

let fixture: Awaited<ReturnType<typeof buildFixture>>
beforeEach(async () => {
  fixture = await buildFixture()
})
afterEach(() => {
  fixture.cleanup()
})

const ALICE = "alice@corp"
const BOB = "bob@corp"
const ALICE_THREAD = DEFAULT_THREAD
const BOB_THREAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

function turn(over: Partial<TurnInputs> & Pick<TurnInputs, "goal" | "threadId" | "upn">): TurnInputs {
  return {
    goal: over.goal,
    answer: over.answer ?? salientAnswer(over.goal),
    threadId: over.threadId,
    upn: over.upn,
    agentId: over.agentId ?? null
  }
}

describe("Layer C — C1: empty-result safety", () => {
  it("retrieveContext on a fresh DB returns empty perTier strings", async () => {
    const result = await fixture.retrieve({
      goal: "any goal",
      threadId: ALICE_THREAD,
      upn: ALICE,
      runId: "run-c1"
    })
    expect(result.perTier.working).toBe("")
    expect(result.perTier.episodic).toBe("")
    expect(result.perTier.semantic).toBe("")
  })
})

describe("Layer C — C2: working memory respects WORKING_SESSION_WINDOW_H cutoff", () => {
  it("entries created >4h ago do NOT appear in working tier", async () => {
    const fourHoursMs = 4 * 60 * 60 * 1000
    const oldStamp = new Date(Date.now() - fourHoursMs - 60_000).toISOString()
    fixture.db
      .prepare(`INSERT OR IGNORE INTO users (upn, display_name, is_admin, source) VALUES (?, ?, 0, 'local')`)
      .run(ALICE, ALICE)
    fixture.db
      .prepare(
        `INSERT OR IGNORE INTO threads (id, upn, title, created_at, updated_at, archived_at, pinned)
         VALUES (?, ?, 'T', datetime('now'), datetime('now'), NULL, 0)`
      )
      .run(ALICE_THREAD, ALICE)
    fixture.db
      .prepare(
        `INSERT INTO runs (id, goal, status, answer, step_count, error, parent_run_id, agent_id, created_at, completed_at, thread_id, upn, display_name)
         VALUES ('run-old-c2', 'old', 'completed', NULL, 1, NULL, NULL, NULL, ?, ?, ?, ?, ?)`
      )
      .run(oldStamp, oldStamp, ALICE_THREAD, ALICE, ALICE)
    fixture.db
      .prepare(
        `
      INSERT INTO memory_entries
        (id, tier, role, content, metadata, source, confidence, salience, access_count, run_id, parent_id, upn, shared, created_at, updated_at)
      VALUES (?, 'working', 'system', ?, '{}', 'agent', 0.9, 0.5, 0, 'run-old-c2', NULL, ?, 0, ?, ?)
    `
      )
      .run(
        "stale-entry-c2",
        "stale-window-marker-OSCAR-9999 should be excluded by the 4h cutoff",
        ALICE,
        oldStamp,
        oldStamp
      )

    await fixture.simulateTurn(
      turn({
        goal: "fresh thing",
        answer:
          "Configured fresh state: fresh-window-marker-PAPA-1111 has been recorded in the live window.",
        threadId: ALICE_THREAD,
        upn: ALICE
      })
    )

    const view = await fixture.retrieve({
      goal: "yes",
      threadId: ALICE_THREAD,
      upn: ALICE,
      runId: "run-c2-retrieve"
    })

    expect(view.perTier.working).toContain("fresh-window-marker-PAPA-1111")
    expect(view.perTier.working).not.toContain("OSCAR-9999")
  })
})

describe("Layer C — C3: shared semantic rows", () => {
  it("a shared semantic row appears for both Alice and Bob queries", async () => {
    fixture.mem.ingestTurn({
      tier: "semantic",
      role: "system",
      content: "Org policy: shared-canary-marker-TANGO-5050 applies to all tenants per platform docs.",
      source: "agent",
      confidence: 0.95,
      runId: "run-shared-c3",
      upn: null,
      shared: true
    })

    const aliceView = await fixture.retrieve({
      goal: "shared-canary-marker-TANGO",
      threadId: ALICE_THREAD,
      upn: ALICE,
      runId: "run-alice-c3"
    })
    const bobView = await fixture.retrieve({
      goal: "shared-canary-marker-TANGO",
      threadId: BOB_THREAD,
      upn: BOB,
      runId: "run-bob-c3"
    })

    expect(aliceView.perTier.semantic).toContain("TANGO-5050")
    expect(bobView.perTier.semantic).toContain("TANGO-5050")
  })
})

describe("Layer C — C4: thread isolation", () => {
  it("working memory from one thread is invisible in another thread for the same user", async () => {
    await fixture.simulateTurn(
      turn({
        goal: "thread A",
        answer: "Configured marker-WHISKEY-AAAA in thread A.",
        threadId: ALICE_THREAD,
        upn: ALICE
      })
    )

    const otherThreadView = await fixture.retrieve({
      goal: "yes",
      threadId: BOB_THREAD,
      upn: ALICE,
      runId: "run-other-thread"
    })

    expect(otherThreadView.perTier.working).not.toContain("WHISKEY-AAAA")
  })
})

describe("Layer C — C5: tenant isolation", () => {
  it("Alice and Bob do not see each other's thread content", async () => {
    await fixture.simulateTurn(
      turn({
        goal: "Alice query",
        answer: "Configured Alice's project with marker-WHISKEY-AAAA.",
        threadId: ALICE_THREAD,
        upn: ALICE
      })
    )
    await fixture.simulateTurn(
      turn({
        goal: "Bob query",
        answer: "Configured Bob's project with marker-XRAY-BBBB.",
        threadId: BOB_THREAD,
        upn: BOB
      })
    )

    const aliceFull = await fixture.retrieve({
      goal: "yes",
      threadId: ALICE_THREAD,
      upn: ALICE,
      runId: "run-alice-c5"
    })
    const bobFull = await fixture.retrieve({
      goal: "yes",
      threadId: BOB_THREAD,
      upn: BOB,
      runId: "run-bob-c5"
    })

    const aliceText = `${aliceFull.perTier.working}\n${aliceFull.perTier.episodic}\n${aliceFull.perTier.semantic}`
    const bobText = `${bobFull.perTier.working}\n${bobFull.perTier.episodic}\n${bobFull.perTier.semantic}`

    expect(aliceText).toContain("WHISKEY-AAAA")
    expect(aliceText).not.toContain("XRAY-BBBB")
    expect(bobText).toContain("XRAY-BBBB")
    expect(bobText).not.toContain("WHISKEY-AAAA")
  })
})
