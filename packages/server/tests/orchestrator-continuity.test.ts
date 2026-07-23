/**
 * Layer A — thread-scoped conversation continuity tests.
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
const OTHER_THREAD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

function turn(over: Partial<TurnInputs> & Pick<TurnInputs, "goal" | "threadId" | "upn">): TurnInputs {
  return {
    goal: over.goal,
    answer: over.answer ?? salientAnswer(over.goal),
    threadId: over.threadId,
    upn: over.upn
  }
}

describe("Layer A — A1: short follow-up sees prior turn", () => {
  it("a short query like 'yes' surfaces the previous turn's answer in the same thread", async () => {
    await fixture.simulateTurn(
      turn({
        goal: "Tell me what the canary value is",
        answer:
          "Configured the canary: the previous-turn-marker-canary value is FOXTROT-7747. I executed the lookup and verified the result.",
        threadId: ALICE_THREAD,
        upn: ALICE
      })
    )

    const followUp = await fixture.retrieve({
      goal: "yes",
      threadId: ALICE_THREAD,
      upn: ALICE,
      runId: "run-followup-A1"
    })

    expect(followUp.perTier.working).toContain("FOXTROT-7747")
  })
})

describe("Layer A — A2: thread isolation", () => {
  it("working memory from thread A does not appear in thread B for the same user", async () => {
    await fixture.simulateTurn(
      turn({
        goal: "Note the tab-1 secret value",
        answer:
          "Configured tab-1 marker TAB1-SECRET-DELTA-3399 by writing it to local state and verifying the recorded value.",
        threadId: ALICE_THREAD,
        upn: ALICE
      })
    )

    const otherView = await fixture.retrieve({
      goal: "ok",
      threadId: OTHER_THREAD,
      upn: ALICE,
      runId: "run-other-A2"
    })

    expect(otherView.perTier.working).not.toContain("TAB1-SECRET-DELTA-3399")
  })
})

describe("Layer A — A3: tenant isolation", () => {
  it("Bob does not see Alice's working memory in a different thread", async () => {
    await fixture.simulateTurn(
      turn({
        goal: "Alice notes her project codename",
        answer:
          "Configured Alice's project: codename ALPHA-TEAM-HOTEL-9911. I executed the assignment and verified persistence.",
        threadId: ALICE_THREAD,
        upn: ALICE
      })
    )

    const bobView = await fixture.retrieve({
      goal: "yes",
      threadId: OTHER_THREAD,
      upn: BOB,
      runId: "run-bob-A3"
    })

    expect(bobView.perTier.working).not.toContain("ALPHA-TEAM-HOTEL-9911")
  })
})

describe("Layer A — A4: follow-up turn in same thread sees prior answer", () => {
  it("excludeRunId hides only the current run, not prior turns in the thread", async () => {
    await fixture.simulateTurn(
      turn({
        goal: "first question",
        answer: "Configured first answer with marker-ECHO-1212.",
        threadId: ALICE_THREAD,
        upn: ALICE
      })
    )

    const second = await fixture.simulateTurn(
      turn({
        goal: "yes",
        answer: "Acknowledged.",
        threadId: ALICE_THREAD,
        upn: ALICE
      })
    )

    const view = await fixture.retrieve({
      goal: "yes",
      threadId: ALICE_THREAD,
      upn: ALICE,
      runId: second.runId
    })

    expect(view.perTier.working).toContain("ECHO-1212")
  })
})
