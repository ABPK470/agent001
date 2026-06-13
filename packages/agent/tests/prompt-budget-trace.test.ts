/**
 * Phase 6 telemetry: prepareIterationContext must emit a
 * planner-prompt-budget trace once per iteration when the prompt budget
 * actually constrained the messages (drops or truncations).
 */
import { describe, expect, it } from "vitest"
import { prepareIterationContext } from "../src/application/shell/agent-cluster/iteration-prepare.js"
import { createAgentLoopState } from "../src/application/shell/loop.js"
import type { Message } from "../src/domain/agent-types.js"

function msg(role: Message["role"], content: string, section?: Message["section"]): Message {
  return { role, content, ...(section ? { section } : {}) } as Message
}

describe("planner-prompt-budget trace", () => {
  it("emits when truncation actually constrained the prompt", () => {
    const trace: Array<Record<string, unknown>> = []
    const fat = "x".repeat(80_000)
    const messages: Message[] = [
      msg("system", "anchor", "system_anchor"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", fat, "history"),
      msg("user", "Real request", "user")
    ]
    // Force a tiny model so budget genuinely bites.
    prepareIterationContext({
      messages,
      iteration: 7,
      state: createAgentLoopState(3),
      toolList: [],
      userGoal: "Real request",
      modelHint: "tiny-test-model",
      config: {
        verbose: false,
        onNudge: () => {},
        onPlannerTrace: (entry) => trace.push(entry as Record<string, unknown>)
      }
    })

    const budgetTraces = trace.filter((t) => t["kind"] === "planner-prompt-budget")
    expect(budgetTraces.length).toBeGreaterThanOrEqual(1)
    const t = budgetTraces[0]
    expect(t).toMatchObject({
      kind: "planner-prompt-budget",
      iteration: 7,
      model: "tiny-test-model",
      constrained: true
    })
    expect(typeof t["totalBeforeChars"]).toBe("number")
    expect(typeof t["totalAfterChars"]).toBe("number")
    expect((t["totalAfterChars"] as number) <= (t["totalBeforeChars"] as number)).toBe(true)
    expect(t["sectionAfterChars"]).toBeTypeOf("object")
    expect(t["sectionAfterMessages"]).toBeTypeOf("object")
  })

  it("does NOT emit when the prompt fits comfortably", () => {
    const trace: Array<Record<string, unknown>> = []
    const messages: Message[] = [msg("system", "anchor", "system_anchor"), msg("user", "hi", "user")]
    prepareIterationContext({
      messages,
      iteration: 1,
      state: createAgentLoopState(3),
      toolList: [],
      userGoal: "hi",
      config: {
        verbose: false,
        onNudge: () => {},
        onPlannerTrace: (entry) => trace.push(entry as Record<string, unknown>)
      }
    })
    const budgetTraces = trace.filter((t) => t["kind"] === "planner-prompt-budget")
    expect(budgetTraces).toEqual([])
  })
})
