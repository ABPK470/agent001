/**
 * Layer C — logical invariant tests.
 *
 * Where Layer A exercises CONVERSATION CONTINUITY scenarios (multi-turn flows
 * that should work end-to-end), Layer C pins LOGICAL INVARIANTS the memory
 * subsystem MUST satisfy regardless of what the orchestrator happens to do
 * today. Each test here states an invariant in the form "for all inputs
 * satisfying P, retrieve(...) MUST satisfy Q" and is derived from logic, not
 * from current code. A future refactor that violates one of these breaks the
 * conversation guarantees this system is built on, even if every module test
 * still passes.
 *
 * Companion artefacts: tests/orchestrator-continuity.test.ts (Layer A),
 * tests/wiring-contracts.test.ts (Layer B), tests/memory-tenancy.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildFixture, salientAnswer, type TurnInputs } from "./helpers/orchestrator-fixture.js"

let fixture: Awaited<ReturnType<typeof buildFixture>>
beforeEach(async () => {
  fixture = await buildFixture()
})
afterEach(() => {
  fixture.cleanup()
})

const ALICE_SID = "anon:c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"
const BOB_SID = "anon:c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2"

function turn(over: Partial<TurnInputs> & Pick<TurnInputs, "goal" | "sessionId">): TurnInputs {
  return {
    goal: over.goal,
    answer: over.answer ?? salientAnswer(over.goal),
    sessionId: over.sessionId,
    upn: over.upn ?? null,
    agentId: over.agentId ?? null
  }
}

// ── C1 — Empty-result safety ─────────────────────────────────────

describe("Layer C — C1: empty-result safety", () => {
  it("retrieveContext on a fresh DB returns perTier with empty strings, never null/undefined/throws", async () => {
    // Invariant: callers downstream (run-executor, system-prompt builder)
    // assume perTier.{working,episodic,semantic} are always strings. A
    // null/undefined here would crash the prompt builder mid-run.
    const result = await fixture.retrieve({
      goal: "any goal",
      sessionId: ALICE_SID,
      upn: null,
      runId: "run-c1"
    })
    expect(typeof result.perTier.working).toBe("string")
    expect(typeof result.perTier.episodic).toBe("string")
    expect(typeof result.perTier.semantic).toBe("string")
    expect(result.perTier.working).toBe("")
    expect(result.perTier.episodic).toBe("")
    expect(result.perTier.semantic).toBe("")
  })

  it("a short ('yes') goal on a fresh DB also returns empty strings without throwing", async () => {
    // The recency-fallback path is a separate code branch; pin it too.
    const result = await fixture.retrieve({
      goal: "yes",
      sessionId: ALICE_SID,
      upn: null,
      runId: "run-c1b"
    })
    expect(result.perTier.working).toBe("")
  })
})

// ── C2 — Working memory time-window cutoff ───────────────────────

describe("Layer C — C2: working memory respects WORKING_SESSION_WINDOW_H cutoff", () => {
  it("entries created >4h ago do NOT appear in working tier even with matching sid+upn", async () => {
    const sid = ALICE_SID
    const fourHoursMs = 4 * 60 * 60 * 1000

    // Plant a row stamped just over the window. We bypass ingestTurn's
    // timestamp logic by inserting directly to memory_entries with a
    // synthetic created_at — this is the only way to test the cutoff
    // without freezing the clock.
    const oldId = "stale-entry-c2"
    const oldStamp = new Date(Date.now() - fourHoursMs - 60_000).toISOString()
    fixture.db
      .prepare(
        `
      INSERT INTO memory_entries
        (id, tier, role, content, metadata, source, confidence, salience, access_count, session_id, run_id, parent_id, upn, shared, created_at, updated_at)
      VALUES (?, 'working', 'system', ?, '{}', 'agent', 0.9, 0.5, 0, ?, 'run-old-c2', NULL, NULL, 0, ?, ?)
    `
      )
      .run(
        oldId,
        "stale-window-marker-OSCAR-9999 should be excluded by the 4h cutoff",
        sid,
        oldStamp,
        oldStamp
      )

    // Plant a fresh row with the same shape so we know retrieval is wired.
    await fixture.simulateTurn(
      turn({
        goal: "fresh thing",
        answer: "Configured fresh state: fresh-window-marker-PAPA-1111 has been recorded in the live window.",
        sessionId: sid,
        upn: null
      })
    )

    const view = await fixture.retrieve({
      goal: "yes",
      sessionId: sid,
      upn: null,
      runId: "run-c2-retrieve"
    })

    expect(view.perTier.working, "fresh entry must surface").toContain("fresh-window-marker-PAPA-1111")
    expect(
      view.perTier.working,
      "stale entry past WORKING_SESSION_WINDOW_H MUST NOT appear regardless of sid/upn match"
    ).not.toContain("OSCAR-9999")
  })
})

// ── C3 — shared=1 rows are visible across all tenants ───────────

describe("Layer C — C3: shared=1 admin-curated rows are visible across tenants", () => {
  it("a shared semantic row appears for both Alice and Bob queries", async () => {
    // Plant an admin-curated shared knowledge row (e.g. policy doc).
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
      sessionId: ALICE_SID,
      upn: "alice@corp",
      runId: "run-alice-c3"
    })
    const bobView = await fixture.retrieve({
      goal: "shared-canary-marker-TANGO",
      sessionId: BOB_SID,
      upn: "bob@corp",
      runId: "run-bob-c3"
    })

    expect(aliceView.perTier.semantic).toContain("TANGO-5050")
    expect(bobView.perTier.semantic).toContain("TANGO-5050")
  })

  it("a NON-shared semantic row stays private to its owning upn", async () => {
    // Same shape, shared=false → must NOT cross tenant boundary.
    fixture.mem.ingestTurn({
      tier: "semantic",
      role: "system",
      content: "Alice-private semantic row: private-canary-marker-UNIFORM-7070 is internal to alice@corp",
      source: "agent",
      confidence: 0.95,
      runId: "run-private-c3",
      upn: "alice@corp",
      shared: false
    })

    const aliceView = await fixture.retrieve({
      goal: "private-canary-marker-UNIFORM",
      sessionId: ALICE_SID,
      upn: "alice@corp",
      runId: "run-alice-private-c3"
    })
    const bobView = await fixture.retrieve({
      goal: "private-canary-marker-UNIFORM",
      sessionId: BOB_SID,
      upn: "bob@corp",
      runId: "run-bob-private-c3"
    })

    expect(aliceView.perTier.semantic).toContain("UNIFORM-7070")
    expect(bobView.perTier.semantic).not.toContain("UNIFORM-7070")
  })
})

// ── C4 — Anon → named UPN promotion (welcome modal flow) ────────

describe("Layer C — C4: anon→named UPN promotion preserves working continuity", () => {
  /**
   * Welcome-modal flow per identity.ts: when an anonymous browser submits
   * the welcome modal, the SAME sid is reused and the upn is promoted from
   * null → "alice@corp". Anything the user said before the modal was
   * ingested with upn=null; anything after, with upn="alice@corp".
   *
   * The named-user predicates in retrieval.ts (FTS path), getRecentEntries,
   * and vectors.ts include a sid-scope bridge:
   *   (e.upn = ? OR e.shared = 1 OR (e.upn IS NULL AND e.session_id = ?))
   * so legacy anon rows on the SAME sid stay visible after the upn
   * promotion. Cross-sid isolation is preserved (different sids still
   * excluded), matching identity.ts treating sid as the conversation
   * boundary.
   */
  it("after promoting upn=null → 'alice@corp' on the same sid, prior anon turns remain visible", async () => {
    const sid = ALICE_SID

    // Pre-modal: anonymous turn (this is what the user actually typed
    // before clicking the welcome modal).
    await fixture.simulateTurn(
      turn({
        goal: "tell me the canary",
        answer:
          "Configured the canary: the pre-modal-anon-marker-VICTOR-3030 has been recorded and verified.",
        sessionId: sid,
        upn: null
      })
    )

    // Welcome modal submitted — SAME sid (per identity.ts:223), upn now set.
    // Post-modal retrieve from the named user's perspective:
    const postModalView = await fixture.retrieve({
      goal: "yes",
      sessionId: sid,
      upn: "alice@corp",
      runId: "run-post-modal-c4"
    })

    expect(
      postModalView.perTier.working,
      "Welcome-modal upn promotion MUST NOT amnesia-bomb the same sid's prior anon turns " +
        "— per identity.ts the sid is the conversation boundary; upn is a label upgrade."
    ).toContain("VICTOR-3030")
  })

  it("sid-scope bridge does NOT leak anon rows to a DIFFERENT sid (cross-conversation isolation holds)", async () => {
    // Anon turn on Alice's browser sid.
    await fixture.simulateTurn(
      turn({
        goal: "tell me the canary",
        answer:
          "Configured the canary: the pre-modal-anon-marker-WHISKEY-7777 has been recorded and verified.",
        sessionId: ALICE_SID,
        upn: null
      })
    )

    // Bob's separate browser session, named user. Different sid entirely.
    const bobView = await fixture.retrieve({
      goal: "yes",
      sessionId: BOB_SID,
      upn: "bob@corp",
      runId: "run-bob-c4-iso"
    })

    expect(
      bobView.perTier.working + bobView.perTier.episodic + bobView.perTier.semantic,
      "Bridge clause must scope by session_id — anon rows on a foreign sid stay invisible."
    ).not.toContain("WHISKEY-7777")
  })
})

// ── C5 — Tenant tuple uniqueness (parallel to A4 but for cross-tier) ──

describe("Layer C — C5: distinct (sid, upn) tuples produce disjoint context", () => {
  it("Alice's full retrieveContext result shares NO content with Bob's after parallel ingests", async () => {
    // Two named users, each with one substantive turn. Their full perTier
    // outputs should not overlap on the canary tokens, regardless of which
    // tier any given content lands in.
    await fixture.simulateTurn(
      turn({
        goal: "Alice query",
        answer:
          "Configured Alice's project with marker-WHISKEY-AAAA: completed setup, wrote artefacts, validated state.",
        sessionId: ALICE_SID,
        upn: "alice@corp"
      })
    )
    await fixture.simulateTurn(
      turn({
        goal: "Bob query",
        answer:
          "Configured Bob's project with marker-XRAY-BBBB: completed setup, wrote artefacts, validated state.",
        sessionId: BOB_SID,
        upn: "bob@corp"
      })
    )

    const aliceFull = await fixture.retrieve({
      goal: "yes",
      sessionId: ALICE_SID,
      upn: "alice@corp",
      runId: "run-alice-c5"
    })
    const bobFull = await fixture.retrieve({
      goal: "yes",
      sessionId: BOB_SID,
      upn: "bob@corp",
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
