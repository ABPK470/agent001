import { describe, expect, it } from "vitest"
import {
  applyToolContractGuidance,
  resolveToolContractGuidance,
  type ToolContractContext,
  type ToolContractGuidance
} from "../src/tools/_helpers/contract-guidance.js"

const TOOLS = [
  "read_file",
  "write_file",
  "replace_in_file",
  "run_command",
  "browser_check",
  "list_directory",
  "delegate"
] as const

function ctx(overrides: Partial<ToolContractContext> = {}): ToolContractContext {
  return {
    iteration: 0,
    availableToolNames: [...TOOLS],
    lastRoundHadDelegation: false,
    lastDelegationWasReadOnly: false,
    inPostDelegationVerification: false,
    artifactsRequiringReadBeforeMutation: new Set(),
    writtenButNotReread: new Set(),
    userGoal: "Create a file with the number 42",
    ...overrides
  }
}

describe("resolveToolContractGuidance", () => {
  it("routes to verification tools immediately after a mutating delegation", () => {
    const guidance = resolveToolContractGuidance(
      ctx({ lastRoundHadDelegation: true, iteration: 2 })
    )
    expect(guidance?.resolverName).toBe("delegation-verification")
    expect(guidance?.enforcement).toBe("block_other_tools")
    expect(guidance?.routedToolNames).toEqual([
      "read_file",
      "run_command",
      "browser_check",
      "list_directory"
    ])
    expect(guidance?.runtimeInstruction).toContain("subagent just completed")
  })

  it("keeps blocking verification tools while inPostDelegationVerification is set", () => {
    const guidance = resolveToolContractGuidance(
      ctx({
        iteration: 4,
        lastRoundHadDelegation: false,
        inPostDelegationVerification: true
      })
    )
    expect(guidance?.resolverName).toBe("delegation-verification")
    expect(guidance?.runtimeInstruction).toContain("VERIFICATION STILL REQUIRED")
  })

  it("skips delegation verification for read-only delegations", () => {
    const guidance = resolveToolContractGuidance(
      ctx({
        lastRoundHadDelegation: true,
        lastDelegationWasReadOnly: true,
        iteration: 1
      })
    )
    expect(guidance).toBeNull()
  })

  it("blocks mutations until read_file when artifacts require read-before-mutate", () => {
    const guidance = resolveToolContractGuidance(
      ctx({
        iteration: 3,
        artifactsRequiringReadBeforeMutation: new Set(["src/foo.ts"])
      })
    )
    expect(guidance?.resolverName).toBe("read-before-mutation")
    expect(guidance?.routedToolNames).toEqual(["read_file"])
    expect(guidance?.runtimeInstruction).toContain("src/foo.ts")
  })

  it("prefers delegation verification over read-before-mutation", () => {
    const guidance = resolveToolContractGuidance(
      ctx({
        iteration: 2,
        lastRoundHadDelegation: true,
        artifactsRequiringReadBeforeMutation: new Set(["src/foo.ts"])
      })
    )
    expect(guidance?.resolverName).toBe("delegation-verification")
  })

  it("suggests read-back for written-but-not-reread source files", () => {
    const guidance = resolveToolContractGuidance(
      ctx({
        iteration: 2,
        writtenButNotReread: new Set(["src/app.ts", "src/util.ts"])
      })
    )
    expect(guidance?.resolverName).toBe("verify-written-files")
    expect(guidance?.enforcement).toBe("suggestion")
    expect(guidance?.runtimeInstruction).toContain("src/app.ts")
  })

  it("does not nudge verify-written-files on iteration 0", () => {
    const guidance = resolveToolContractGuidance(
      ctx({
        iteration: 0,
        writtenButNotReread: new Set(["src/app.ts"])
      })
    )
    expect(guidance?.resolverName).toBe("encourage-first-turn-tools")
  })

  it("suggests tool use on the first iteration for task goals", () => {
    const guidance = resolveToolContractGuidance(ctx({ iteration: 0 }))
    expect(guidance?.resolverName).toBe("encourage-first-turn-tools")
    expect(guidance?.enforcement).toBe("suggestion")
  })

  it("skips first-turn tool nudge for dialogue goals", () => {
    const guidance = resolveToolContractGuidance(
      ctx({ iteration: 0, userGoal: "Hello!" })
    )
    expect(guidance).toBeNull()
  })

  it("skips first-turn tool nudge for session meta questions", () => {
    const guidance = resolveToolContractGuidance(
      ctx({ iteration: 0, userGoal: "What are we doing?" })
    )
    expect(guidance).toBeNull()
  })

  it("nudges first-turn tools when user assents to a prior offer", () => {
    const priorTurns = {
      role: "system" as const,
      section: "system_anchor" as const,
      content: [
        "<prior_turns>",
        "Turn -1",
        "  Goal: count LOC",
        "  Answer:",
        "    Total is 100.",
        "    I can also split src vs tests.",
        "</prior_turns>"
      ].join("\n")
    }
    const guidance = resolveToolContractGuidance(
      ctx({
        iteration: 0,
        userGoal: "ok",
        messages: [priorTurns]
      })
    )
    expect(guidance?.resolverName).toBe("encourage-first-turn-tools")
  })

  it("returns null when no resolver applies", () => {
    expect(
      resolveToolContractGuidance(
        ctx({ iteration: 5, availableToolNames: ["write_file"] })
      )
    ).toBeNull()
  })

  it("returns null when verification tools are unavailable after delegation", () => {
    expect(
      resolveToolContractGuidance(
        ctx({
          iteration: 2,
          lastRoundHadDelegation: true,
          availableToolNames: ["write_file", "delegate"]
        })
      )
    ).toBeNull()
  })
})

describe("applyToolContractGuidance", () => {
  const blockGuidance: ToolContractGuidance = {
    priority: 270,
    resolverName: "read-before-mutation",
    routedToolNames: ["read_file"],
    enforcement: "block_other_tools",
    runtimeInstruction: "read first"
  }

  it("filters to routed tools on block_other_tools", () => {
    const applied = applyToolContractGuidance(blockGuidance, TOOLS)
    expect(applied.filteredToolNames).toEqual(["read_file"])
    expect(applied.injectedInstruction).toBe("read first")
  })

  it("falls back to the full tool list when blocking would remove everything", () => {
    const applied = applyToolContractGuidance(blockGuidance, ["write_file", "delegate"])
    expect(applied.filteredToolNames).toEqual(["write_file", "delegate"])
  })

  it("keeps all tools for suggestion enforcement", () => {
    const applied = applyToolContractGuidance(
      {
        priority: 200,
        resolverName: "encourage-first-turn-tools",
        routedToolNames: TOOLS,
        enforcement: "suggestion",
        runtimeInstruction: "use tools"
      },
      TOOLS
    )
    expect(applied.filteredToolNames).toEqual(TOOLS)
  })
})
