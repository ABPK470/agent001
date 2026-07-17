import { describe, expect, it } from "vitest"
import { createAgentLoopState } from "../src/runtime/loop/state.js"
import {
  guardCompletion,
  prepareTurn,
  turnStartContext,
  type LoopPolicyContext
} from "../src/runtime/loop/loop-policy/index.js"

const TOOLS = [
  "read_file",
  "write_file",
  "replace_in_file",
  "run_command",
  "run_command",
  "list_directory",
  "delegate"
] as const

function turnCtx(overrides: Partial<LoopPolicyContext> = {}): LoopPolicyContext {
  const state = createAgentLoopState(30)
  return {
    iteration: 0,
    userGoal: "Create a file with the number 42",
    messages: [],
    state,
    toolList: [],
    availableToolNames: [...TOOLS],
    ...overrides
  }
}

describe("loop-policy prepareTurn", () => {
  it("routes to verification tools immediately after a mutating delegation", () => {
    const prep = prepareTurn(
      turnCtx({
        iteration: 2,
        state: Object.assign(createAgentLoopState(30), {
          lastRoundHadDelegation: true
        })
      })
    )
    expect(prep.rule).toBe("delegation-verification")
    expect(prep.allowedToolNames).toEqual([
      "read_file",
      "run_command",
      "run_command",
      "list_directory"
    ])
    expect(prep.hint).toContain("subagent just completed")
  })

  it("keeps verification tools while inPostDelegationVerification is set", () => {
    const state = createAgentLoopState(30)
    state.inPostDelegationVerification = true
    const prep = prepareTurn(turnCtx({ iteration: 4, state }))
    expect(prep.rule).toBe("delegation-verification")
    expect(prep.hint).toContain("VERIFICATION STILL REQUIRED")
  })

  it("skips delegation verification for read-only delegations", () => {
    const state = createAgentLoopState(30)
    state.lastRoundHadDelegation = true
    state.lastDelegationWasReadOnly = true
    const prep = prepareTurn(turnCtx({ iteration: 1, state }))
    expect(prep.rule).toBeNull()
    expect(prep.allowedToolNames).toEqual([...TOOLS])
  })

  it("blocks mutations until read_file when artifacts require read-before-mutate", () => {
    const state = createAgentLoopState(30)
    state.artifactsRequiringReadBeforeMutation.add("src/foo.ts")
    const prep = prepareTurn(turnCtx({ iteration: 3, state }))
    expect(prep.rule).toBe("read-before-mutation")
    expect(prep.allowedToolNames).toEqual(["read_file"])
    expect(prep.hint).toContain("src/foo.ts")
  })

  it("prefers delegation verification over read-before-mutation", () => {
    const state = createAgentLoopState(30)
    state.lastRoundHadDelegation = true
    state.artifactsRequiringReadBeforeMutation.add("src/foo.ts")
    const prep = prepareTurn(turnCtx({ iteration: 2, state }))
    expect(prep.rule).toBe("delegation-verification")
  })

  it("returns no rule when nothing applies", () => {
    const prep = prepareTurn(turnCtx({ iteration: 5, availableToolNames: ["write_file"] }))
    expect(prep.rule).toBeNull()
    expect(prep.hint).toBeNull()
  })

  it("skips read-before-mutation when read_file is unavailable", () => {
    const state = createAgentLoopState(30)
    state.artifactsRequiringReadBeforeMutation.add("src/foo.ts")
    const prep = prepareTurn(
      turnCtx({ iteration: 1, state, availableToolNames: ["write_file", "delegate"] })
    )
    expect(prep.rule).toBeNull()
    expect(prep.allowedToolNames).toEqual(["write_file", "delegate"])
  })

  it("hides all tools on iteration 0 for dialogue goals", () => {
    const prep = prepareTurn(
      turnCtx({ iteration: 0, userGoal: "Hi", availableToolNames: [...TOOLS] })
    )
    expect(prep.rule).toBe("direct-dialogue")
    expect(prep.allowedToolNames).toEqual([])
    expect(prep.hint).toMatch(/do not call any tools/i)
  })

  it("hides all tools on iteration 0 for bare check-ins like test", () => {
    const prep = prepareTurn(
      turnCtx({ iteration: 0, userGoal: "test", availableToolNames: [...TOOLS] })
    )
    expect(prep.rule).toBe("direct-dialogue")
    expect(prep.allowedToolNames).toEqual([])
  })

  it("still allows tools on iteration 0 for task goals", () => {
    const prep = prepareTurn(turnCtx({ iteration: 0 }))
    expect(prep.rule).toBeNull()
    expect(prep.allowedToolNames).toEqual([...TOOLS])
  })
})

describe("loop-policy guardCompletion", () => {
  it("blocks early text-only exit on iteration 0 for task goals", async () => {
    const state = createAgentLoopState(30)
    const block = await guardCompletion({
      ...turnCtx({ iteration: 0, state, toolList: [{ name: "read_file" } as never] }),
      response: { content: "I will create the file now.", toolCalls: [] },
      config: {
        maxIterations: 30,
        enablePlanner: false,
        plannerDelegateFn: undefined,
        completionValidator: undefined,
        verbose: false
      }
    })
    expect(block?.tag).toBe("early-exit-nudge")
  })

  it("allows dialogue goals to finish on iteration 0", async () => {
    const block = await guardCompletion({
      ...turnCtx({ iteration: 0, userGoal: "Hello!" }),
      response: { content: "Hi there!", toolCalls: [] },
      config: {
        maxIterations: 30,
        enablePlanner: false,
        plannerDelegateFn: undefined,
        completionValidator: undefined,
        verbose: false
      }
    })
    expect(block).toBeNull()
  })
})

describe("turnStartContext", () => {
  it("builds availableToolNames from toolList", () => {
    const ctx = turnStartContext({
      iteration: 1,
      userGoal: "test",
      messages: [],
      state: createAgentLoopState(10),
      toolList: [{ name: "read_file" } as never, { name: "write_file" } as never]
    })
    expect(ctx.availableToolNames).toEqual(["read_file", "write_file"])
  })
})
