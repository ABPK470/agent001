/**
 * Layer A — orchestrator-level conversation continuity tests.
 *
 * These tests are derived from LOGIC (what SHOULD be true about a multi-turn
 * conversation), not from current code. If a future refactor regresses
 * conversation continuity in any of the ways exercised here, the failing
 * test names tell you exactly which logical invariant broke.
 *
 * Companion artefacts:
 *   - tests/helpers/orchestrator-fixture.ts — harness + invariant catalogue
 *   - tests/wiring-contracts.test.ts        — static drift detection
 *   - tests/memory-tenancy.test.ts          — module-level isolation
 *
 * The bug that motivated this layer: a one-line mismatch between
 * retrieveContext (read) and ingestRunTurns (write) sessionId expressions
 * caused short follow-up messages like "yes" to land in an empty bucket
 * because the recency-fallback path keyed off a different identity than
 * the ingest path. None of the existing module tests caught it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildFixture, salientAnswer, type TurnInputs } from "./helpers/orchestrator-fixture.js"

let fixture: Awaited<ReturnType<typeof buildFixture>>

beforeEach(async () => { fixture = await buildFixture() })
afterEach(() => { fixture.cleanup() })

// Realistic per-browser sids matching auth/identity.ts:resolveSession()'s
// `anon:<16-byte-hex>` shape. Using realistic shapes (not "session-1") makes
// it obvious if a test accidentally collides on a magic string.
const ALICE_ANON_SID = "anon:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
const BOB_ANON_SID   = "anon:b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
const ALICE_NEW_TAB  = "anon:a1a1a1a1a1a1a1a1FFFFFFFFFFFFFFFF"

function turn(over: Partial<TurnInputs> & Pick<TurnInputs, "goal" | "sessionId">): TurnInputs {
  return {
    goal:      over.goal,
    answer:    over.answer    ?? salientAnswer(over.goal),
    sessionId: over.sessionId,
    upn:       over.upn       ?? null,
    agentId:   over.agentId   ?? null,
  }
}

// ── A1 — THE LITERAL "yes had no context" REGRESSION ────────────

describe("Layer A — A1: short follow-up sees prior turn via recency fallback", () => {
  it("a short query like 'yes' surfaces the previous turn's answer in the same session", async () => {
    // Turn 1: agent makes a substantive statement and stores it.
    const sid = ALICE_ANON_SID
    await fixture.simulateTurn(turn({
      goal: "Tell me what the canary value is",
      answer: "Configured the canary: the previous-turn-marker-canary value is FOXTROT-7747. I executed the lookup and verified the result.",
      sessionId: sid,
      upn: null,
    }))

    // Turn 2: the user replies "yes" — sanitizeFtsQuery() returns empty,
    // retrieveContext MUST fall back to recency-ordered working memory for
    // this session. If sessionId drifts on EITHER side this returns "".
    const followUp = await fixture.retrieve({
      goal: "yes",
      sessionId: sid,
      upn: null,
      runId: "run-followup-A1",
    })

    expect(
      followUp.perTier.working,
      "I1+I6: short follow-up MUST recover prior turn's answer from working memory via the recency fallback. " +
      "If this is empty, retrieveContext is reading a different sessionId than ingestRunTurns wrote.",
    ).toContain("FOXTROT-7747")
  })
})

// ── A2 — Session isolation within the same authenticated user ───

describe("Layer A — A2: same upn, different sessionIds do not bleed", () => {
  it("Alice's tab-1 working memory does not appear in Alice's tab-2 short query", async () => {
    const upn = "alice@corp"
    await fixture.simulateTurn(turn({
      goal: "Note the tab-1 secret value",
      answer: "Configured tab-1 marker TAB1-SECRET-DELTA-3399 by writing it to local state and verifying the recorded value.",
      sessionId: ALICE_ANON_SID,
      upn,
    }))

    const tab2View = await fixture.retrieve({
      goal: "ok",
      sessionId: ALICE_NEW_TAB,
      upn,
      runId: "run-tab2-A2",
    })

    expect(tab2View.perTier.working).not.toContain("TAB1-SECRET-DELTA-3399")
  })
})

// ── A3 — Cross-tenant isolation (distinct upns) ─────────────────

describe("Layer A — A3: same sessionId would still be UPN-isolated", () => {
  it("Bob does not see Alice's working memory even on a hypothetical sid collision", async () => {
    // Hypothetical: in production sids are unique per browser, but identity
    // can change cookies (e.g. if a browser is re-used). UPN is the strong
    // tenancy boundary; this test pins that even with the same sid string,
    // a different upn never leaks the other's working memory.
    const sharedSid = "shared-cookie-sid-by-coincidence"
    await fixture.simulateTurn(turn({
      goal: "Alice notes her project codename",
      answer: "Configured Alice's project: codename ALPHA-TEAM-HOTEL-9911. I executed the assignment and verified persistence.",
      sessionId: sharedSid,
      upn: "alice@corp",
    }))

    const bobView = await fixture.retrieve({
      goal: "yes",
      sessionId: sharedSid,
      upn: "bob@corp",
      runId: "run-bob-A3",
    })

    expect(bobView.perTier.working).not.toContain("ALPHA-TEAM-HOTEL-9911")
  })
})

// ── A4 — Anonymous-dev isolation (the case that the original bug broke) ──

describe("Layer A — A4: anonymous (upn=null) different sids stay isolated", () => {
  it("two anonymous dev browsers with distinct anon:<uuid> sids do not share working memory", async () => {
    // This is the exact scenario the original bug collapsed: dev mode has
    // no upn, every browser gets a unique anon:<uuid> sid (per
    // auth/identity.ts:resolveSession), and the OLD code's
    // `agentId ?? "default"` fallback put them all in one shared "default"
    // bucket on the read side while the write side correctly used the sid.
    await fixture.simulateTurn(turn({
      goal: "Alice asks about the dev marker",
      answer: "Configured the dev test: alice-only-marker-ECHO-5511 was written to the dev workspace and validated.",
      sessionId: ALICE_ANON_SID,
      upn: null,
    }))
    await fixture.simulateTurn(turn({
      goal: "Bob asks about a different marker",
      answer: "Configured Bob's setup: bob-only-marker-INDIA-2299 has been recorded and verified in the workspace.",
      sessionId: BOB_ANON_SID,
      upn: null,
    }))

    const alicesView = await fixture.retrieve({
      goal: "yes",
      sessionId: ALICE_ANON_SID,
      upn: null,
      runId: "run-alice-A4",
    })
    const bobsView = await fixture.retrieve({
      goal: "yes",
      sessionId: BOB_ANON_SID,
      upn: null,
      runId: "run-bob-A4",
    })

    // Each anon dev browser sees its own marker, NOT the other's.
    expect(alicesView.perTier.working).toContain("alice-only-marker-ECHO-5511")
    expect(alicesView.perTier.working).not.toContain("bob-only-marker-INDIA-2299")

    expect(bobsView.perTier.working).toContain("bob-only-marker-INDIA-2299")
    expect(bobsView.perTier.working).not.toContain("alice-only-marker-ECHO-5511")
  })
})

// ── A5 — excludeRunId still surfaces prior runs in the same session ──

describe("Layer A — A5: prior runs visible across runId boundary in same session", () => {
  it("turn 2 in the same session sees turn 1's answer (different runId, same session)", async () => {
    // The retrieveContext call passes the CURRENT runId so that the agent's
    // own in-flight memory does not echo back into its own context. Prior
    // completed runs in the same session MUST still be visible — that's the
    // whole point of working memory.
    const sid = ALICE_ANON_SID
    await fixture.simulateTurn(turn({
      goal: "Save the persistent canary",
      answer: "Configured persistent state: turn-one-survivor-marker-NOVEMBER-8822 has been written and verified.",
      sessionId: sid,
      upn: null,
    }))

    const t2View = await fixture.retrieve({
      goal: "ok",
      sessionId: sid,
      upn: null,
      runId: "run-fresh-different-from-t1",  // intentionally NOT the previous run's id
    })

    expect(t2View.perTier.working).toContain("turn-one-survivor-marker-NOVEMBER-8822")
  })

  /**
   * A5b — excludeRunId is now honoured uniformly across both retrieval
   * paths (FTS + recency / working-tier merge). Previously the FTS SQL
   * filter at retrieval.ts honoured excludeRunId but the merged-in
   * getRecentEntries() and the empty-FTS recency fallback did not, so an
   * in-flight run's own rows leaked back into its own context. Fixed by
   * threading excludeRunId into getRecentEntries().
   *
   * Logical invariant: when retrieveContext is given an excludeRunId, NO
   * row from that run appears in any perTier block, regardless of which
   * internal path produced it. This matters for resumed runs / agent
   * self-reflection / multi-step planners that ingest mid-run.
   */
  it("A5b: excludeRunId hides in-flight rows on BOTH FTS path and recency-fallback path", async () => {
    const sid = ALICE_ANON_SID
    const inFlightRunId = "run-in-flight-A5b"

    // Plant a row attributed to the in-flight run.
    fixture.mem.ingestTurn({
      tier: "working",
      role: "system",
      content: "in-flight-self-row-distinctive-keyword-ZULU-1188 should be excluded by excludeRunId",
      source: "agent",
      confidence: 0.9,
      sessionId: sid,
      runId: inFlightRunId,
      upn: null,
    })

    // Path 1: FTS query (non-empty, sanitises to a real MATCH expression).
    // The working-tier branch ALSO merges getRecentEntries — both must filter.
    const ftsView = await fixture.retrieve({
      goal: "distinctive-keyword-ZULU",
      sessionId: sid,
      upn: null,
      runId: inFlightRunId,
    })
    expect(
      ftsView.perTier.working,
      "FTS path: in-flight self-row must not appear when excludeRunId is supplied",
    ).not.toContain("ZULU-1188")

    // Path 2: empty FTS query → recency fallback (the literal "yes" path).
    // Without the fix, this leaked the in-flight row even though excludeRunId
    // was supplied.
    const recencyView = await fixture.retrieve({
      goal: "yes",
      sessionId: sid,
      upn: null,
      runId: inFlightRunId,
    })
    expect(
      recencyView.perTier.working,
      "Recency-fallback path: in-flight self-row must not appear when excludeRunId is supplied",
    ).not.toContain("ZULU-1188")

    // Sanity: a DIFFERENT runId still sees the row (the exclusion is targeted,
    // not a blanket suppression).
    const otherRunView = await fixture.retrieve({
      goal: "yes",
      sessionId: sid,
      upn: null,
      runId: "run-some-other-id",
    })
    expect(
      otherRunView.perTier.working,
      "exclusion must be targeted: a different runId still observes the row",
    ).toContain("ZULU-1188")
  })
})

// ── A6 — recency fallback ordering: most recent first ───────────

describe("Layer A — A6: recency fallback returns most recent turn first", () => {
  it("when multiple turns precede a short follow-up, the latest turn dominates context", async () => {
    const sid = ALICE_ANON_SID
    // Three turns; latest carries the marker we expect to surface.
    await fixture.simulateTurn(turn({
      goal: "first thing",
      answer: "Configured first step: marker-OLDEST-PAPA-1111 recorded and validated.",
      sessionId: sid, upn: null,
    }))
    await fixture.simulateTurn(turn({
      goal: "second thing",
      answer: "Configured second step: marker-MIDDLE-QUEBEC-2222 recorded and validated.",
      sessionId: sid, upn: null,
    }))
    await fixture.simulateTurn(turn({
      goal: "third thing",
      answer: "Configured third step: marker-NEWEST-ROMEO-3333 recorded and validated.",
      sessionId: sid, upn: null,
    }))

    const view = await fixture.retrieve({
      goal: "yes",
      sessionId: sid,
      upn: null,
      runId: "run-final-A6",
    })

    // All three may be present; the newest MUST appear (recency fallback
    // ordering invariant). We assert the strongest necessary condition:
    // newest is present AND appears at or before the oldest within the
    // working-tier text block.
    expect(view.perTier.working).toContain("marker-NEWEST-ROMEO-3333")
    const newestIdx = view.perTier.working.indexOf("marker-NEWEST-ROMEO-3333")
    const oldestIdx = view.perTier.working.indexOf("marker-OLDEST-PAPA-1111")
    if (oldestIdx >= 0) {
      expect(newestIdx, "recency fallback MUST list newest before oldest").toBeLessThan(oldestIdx)
    }
  })
})
