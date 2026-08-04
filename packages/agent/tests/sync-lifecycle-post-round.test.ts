import { describe, expect, it } from "vitest"
import { processPostRound } from "../src/runtime/loop/post-round/index.js"
import { createAgentLoopState } from "../src/runtime/loop/state.js"

function processSyncRound(name: "sync_preview" | "sync_execute", result: string, syncLifecycle?: "executed") {
  const messages: Array<{ role: never; content: string }> = []
  const outcome = processPostRound({
    roundToolCalls: [
      {
        name,
        args: {},
        result,
        isError: false,
        ...(syncLifecycle ? { outcome: { ok: true, summary: result, data: { syncLifecycle } } } : {})
      }
    ],
    response: { content: null, toolCalls: [{ name }] },
    messages,
    state: createAgentLoopState(30),
    iteration: 1,
    config: {
      maxIterations: 30,
      verbose: false,
      deferRecoveryHintsUntilCompletionAttempt: false,
      onNudge: undefined,
      onPlannerTrace: undefined,
      onStep: undefined
    },
    allToolCalls: [],
    failuresThisRound: 0,
    delegationThisRound: false,
    delegationThisRoundWasReadOnly: false
  })
  return { messages, outcome }
}

describe("sync lifecycle post-round handling", () => {
  it("ends successfully executed syncs without another apply instruction", () => {
    const { messages, outcome } = processSyncRound(
      "sync_execute",
      "Plan 123 executed successfully against dev.",
      "executed"
    )
    expect(outcome.needsSynthesis).toBe(true)
    expect(messages.at(-1)?.content).toContain("Do NOT show an apply command")
  })

  it("requires the preview command only for an actionable preview", () => {
    const { messages, outcome } = processSyncRound("sync_preview", "Plan 123 — Totals: +2 ~0 -0")
    expect(outcome.needsSynthesis).toBe(true)
    expect(messages.at(-1)?.content).toContain("must end with exactly the Apply command")
    expect(messages.at(-1)?.content).toContain("separate turn")
  })
})
