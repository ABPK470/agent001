import { ToolControlDirective, ToolOutcomeSeverity } from "@mia/agent"
/**
 * Agent loop guard tests — verify all exit guards fire correctly.
 *
 * Tests each guard in isolation using a scripted LLM:
 *   1. early-exit-nudge (iter 0 exit with tools available)
 *   2. verification-required (post-delegation)
 *   3. write-without-verify (wrote files but didn't read/check)
 *   4. verification-failed (verified, found errors, tried to exit)
 *   5. completion-validator (stub detection on actual output)
 *   6. budget-warning (iteration budget running low)
 *   7. completionValidator fires at most once (one-shot)
 *   8. normal exit when no guards fire
 */
import { describe, expect, it } from "vitest"
import { Agent } from "../src/runtime/agent.js"
import type { LLMClient, LLMResponse, Tool } from "../src/domain/models/agent-types.js"

// ── Test helpers ─────────────────────────────────────────────────

function echoTool(): Tool {
  return {
    name: "echo",
    description: "Echo text back",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    },
    async execute(args) {
      return `echoed: ${String(args.text)}`
    }
  }
}

function scriptedLLM(responses: LLMResponse[]): LLMClient {
  let callIndex = 0
  return {
    async chat() {
      if (callIndex >= responses.length) {
        return { content: "out of script", toolCalls: [] }
      }
      return responses[callIndex++]!
    }
  }
}

// ── Guard tests ──────────────────────────────────────────────────

describe("Agent loop guards", () => {
  it("fires early-exit-nudge on iteration 0 with no tool calls", async () => {
    const nudges: string[] = []
    const llm = scriptedLLM([
      // Iter 0: tries to exit immediately
      { content: "I can see the answer is 42", toolCalls: [] },
      // Iter 1: forced to use tools, does so, then exits
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hello" } }] },
      { content: "Done after using tools", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      onNudge: (data) => nudges.push(data.tag)
    })
    const answer = await agent.run("do something")

    expect(nudges).toContain("early-exit-nudge")
    expect(answer).toBe("Done after using tools")
  })

  it("allows text-only completion on iteration 0 for dialogue goals", async () => {
    const nudges: string[] = []
    const llm = scriptedLLM([
      { content: "Hi! We were working on your last question — ask me to continue or start something new.", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      onNudge: (data) => nudges.push(data.tag)
    })
    const answer = await agent.run("Hello")

    expect(nudges).not.toContain("early-exit-nudge")
    expect(answer).toContain("Hi!")
  })

  it("fires early-exit-nudge when user assents to a prior assistant offer", async () => {
    const nudges: string[] = []
    const llm = scriptedLLM([
      { content: "Sure, I'll split src vs tests LOC now.", toolCalls: [] },
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "splitting" } }] },
      { content: "Done — src and tests LOC are split.", toolCalls: [] }
    ])

    const priorTurns = {
      role: "system" as const,
      section: "system_anchor" as const,
      content: [
        "<prior_turns>",
        "Turn -1",
        "  Goal: count LOC",
        "  Answer:",
        "    Total LOC is 70,617.",
        "    If you want, I can also split it into src vs tests LOC.",
        "</prior_turns>"
      ].join("\n")
    }

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      systemMessages: [priorTurns],
      onNudge: (data) => nudges.push(data.tag)
    })
    const answer = await agent.run("ok")

    expect(nudges).toContain("early-exit-nudge")
    expect(answer).toContain("Done")
  })

  it("fires write-without-verify when child writes files then exits", async () => {
    const nudges: string[] = []

    // Minimal write_file tool that just returns success
    const writeFileTool: Tool = {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      },
      async execute(args) {
        return `Successfully wrote to ${String(args.path)}`
      }
    }

    const readFileTool: Tool = {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      },
      async execute() {
        return "file contents here"
      }
    }

    const llm = scriptedLLM([
      // Iter 0: writes a JS file
      {
        content: "Writing the file",
        toolCalls: [
          {
            id: "tc1",
            name: "write_file",
            arguments: { path: "app.js", content: "console.log('hi')" }
          }
        ]
      },
      // Iter 1: tries to exit without verifying
      { content: "Done!", toolCalls: [] },
      // Iter 2: forced to verify, reads the file
      { content: null, toolCalls: [{ id: "tc2", name: "read_file", arguments: { path: "app.js" } }] },
      // Iter 3: now exits
      { content: "Verified and done", toolCalls: [] }
    ])

    const agent = new Agent(llm, [writeFileTool, readFileTool], {
      verbose: false,
      onNudge: (data) => nudges.push(data.tag)
    })
    const answer = await agent.run("write a file")

    expect(nudges).toContain("write-without-verify")
    expect(answer).toBe("Verified and done")
  })

  it("fires completion-validator when validator returns issues", async () => {
    const nudges: string[] = []
    let validatorCallCount = 0

    const llm = scriptedLLM([
      // Iter 0: uses a tool
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hello" } }] },
      // Iter 1: tries to exit — validator catches it
      { content: "All done", toolCalls: [] },
      // Iter 2: forced to continue, uses another tool
      { content: null, toolCalls: [{ id: "tc2", name: "echo", arguments: { text: "fixing" } }] },
      // Iter 3: exits — validator already fired (one-shot)
      { content: "Now truly done", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      completionValidator: async () => {
        validatorCallCount++
        if (validatorCallCount === 1) {
          return "COMPLETION CHECK FAILED — your code has stub functions:\n  - isMoveLegal() returns true"
        }
        return null
      },
      onNudge: (data) => nudges.push(data.tag)
    })
    const answer = await agent.run("build something")

    expect(nudges).toContain("completion-validator")
    expect(validatorCallCount).toBe(1) // one-shot: fires only once
    expect(answer).toBe("Now truly done")
  })

  it("fires premature-handoff nudge on partial completion language", async () => {
    const nudges: string[] = []

    const llm = scriptedLLM([
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "work" } }] },
      {
        content: "Core logic is implemented, but full compliance may require additional work.",
        toolCalls: []
      },
      { content: null, toolCalls: [{ id: "tc2", name: "echo", arguments: { text: "finish" } }] },
      { content: "Completed with verified evidence.", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      onNudge: (data) => nudges.push(data.tag)
    })
    const answer = await agent.run("build implementation")

    expect(nudges).toContain("premature-handoff")
    expect(answer).toBe("Completed with verified evidence.")
  })

  it("completion-validator is one-shot — does not fire twice", async () => {
    let validatorCallCount = 0

    const llm = scriptedLLM([
      // Iter 0: work
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "a" } }] },
      // Iter 1: first exit attempt → validator fires
      { content: "exit 1", toolCalls: [] },
      // Iter 2: more work
      { content: null, toolCalls: [{ id: "tc2", name: "echo", arguments: { text: "b" } }] },
      // Iter 3: second exit attempt → validator does NOT fire again
      { content: "exit 2", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      completionValidator: async () => {
        validatorCallCount++
        return "STUBS FOUND"
      }
    })
    const answer = await agent.run("build it")

    expect(validatorCallCount).toBe(1)
    // Second exit succeeds because validator is one-shot
    expect(answer).toBe("exit 2")
  })

  it("completion-validator passes when returning null — agent exits normally", async () => {
    const nudges: string[] = []

    const llm = scriptedLLM([
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "work" } }] },
      { content: "All clean", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      completionValidator: async () => null, // no issues
      onNudge: (data) => nudges.push(data.tag)
    })
    const answer = await agent.run("build it")

    expect(nudges).not.toContain("completion-validator")
    expect(answer).toBe("All clean")
  })

  it("completion-validator error does not block agent exit", async () => {
    const llm = scriptedLLM([
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "a" } }] },
      { content: "done", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      completionValidator: async () => {
        throw new Error("validator crashed!")
      }
    })
    const answer = await agent.run("build it")

    expect(answer).toBe("done")
  })

  it("fires budget-warning when iterations run low", async () => {
    const nudges: string[] = []

    // With maxIterations=3, 80% = 2.4, so remaining<=1 at iter 2
    // But budget fires when remaining <= max(ceil(3*0.2)=1, 2) = 2
    // So it fires at iter 1 (remaining=2)
    const llm = scriptedLLM([
      // Iter 0: work
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "1" } }] },
      // Iter 1: budget warning fires here (remaining=2)
      { content: null, toolCalls: [{ id: "tc2", name: "echo", arguments: { text: "2" } }] },
      // Iter 2: done
      { content: "finished", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      maxIterations: 3,
      verbose: false,
      onNudge: (data) => nudges.push(data.tag)
    })
    await agent.run("quick task")

    expect(nudges).toContain("budget-warning")
  })

  it("agent exits normally when no guards trigger", async () => {
    const nudges: string[] = []

    const llm = scriptedLLM([
      { content: null, toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "work" } }] },
      { content: "All done", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      onNudge: (data) => nudges.push(data.tag)
    })
    const answer = await agent.run("simple task")

    expect(nudges).toHaveLength(0)
    expect(answer).toBe("All done")
  })

  it("aborts after repeated blocked mutation failures on the same artifact", async () => {
    const writeFileTool: Tool = {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      },
      async execute(args) {
        const path = String(args.path)
        return {
          ok: false,
          summary: `WRITTEN WITH ISSUES to ${path} — the file was saved but still contains incomplete logic.`,
          severity: ToolOutcomeSeverity.Recoverable,
          directive: ToolControlDirective.AbortRound,
          errorCode: "artifact_incomplete_mutation",
          details: ["STUB/PLACEHOLDER CODE DETECTED — these functions need REAL implementation."],
          artifacts: [{ path, preservedExisting: false, requiresReadBeforeMutation: true }]
        }
      }
    }

    const llm = scriptedLLM([
      {
        content: null,
        toolCalls: [
          {
            id: "tc1",
            name: "write_file",
            arguments: { path: "tmp/game/chessLogic.js", content: "first" }
          }
        ]
      },
      {
        content: null,
        toolCalls: [
          {
            id: "tc2",
            name: "write_file",
            arguments: { path: "tmp/game/chessLogic.js", content: "second" }
          }
        ]
      },
      {
        content: null,
        toolCalls: [
          {
            id: "tc3",
            name: "write_file",
            arguments: { path: "tmp/game/chessLogic.js", content: "third" }
          }
        ]
      }
    ])

    const agent = new Agent(llm, [writeFileTool], {
      maxIterations: 6,
      verbose: false
    })

    const answer = await agent.run("fix the file")
    expect(answer).toContain("Repeated mutation-blocked attempts on tmp/game/chessLogic.js")
  })

  it("does not reset blocked-artifact failure history just because the child reread the file", async () => {
    const writeFileTool: Tool = {
      name: "write_file",
      description: "Write a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      },
      async execute(args) {
        const path = String(args.path)
        return {
          ok: false,
          summary: `WRITTEN WITH ISSUES to ${path} — the file was saved but still contains incomplete logic.`,
          severity: ToolOutcomeSeverity.Recoverable,
          directive: ToolControlDirective.AbortRound,
          errorCode: "artifact_incomplete_mutation",
          details: ["STUB/PLACEHOLDER CODE DETECTED — these functions need REAL implementation."],
          artifacts: [{ path, preservedExisting: false, requiresReadBeforeMutation: true }]
        }
      }
    }

    const readFileTool: Tool = {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      },
      async execute(args) {
        return `current contents of ${String(args.path)}`
      }
    }

    const llm = scriptedLLM([
      {
        content: null,
        toolCalls: [{ id: "tc1", name: "write_file", arguments: { path: "tmp/game.js", content: "first" } }]
      },
      {
        content: null,
        toolCalls: [{ id: "tc2", name: "read_file", arguments: { path: "tmp/game.js" } }]
      },
      {
        content: null,
        toolCalls: [{ id: "tc3", name: "write_file", arguments: { path: "tmp/game.js", content: "second" } }]
      },
      {
        content: null,
        toolCalls: [{ id: "tc4", name: "read_file", arguments: { path: "tmp/game.js" } }]
      },
      {
        content: null,
        toolCalls: [{ id: "tc5", name: "write_file", arguments: { path: "tmp/game.js", content: "third" } }]
      }
    ])

    const agent = new Agent(llm, [writeFileTool, readFileTool], {
      maxIterations: 8,
      verbose: false
    })

    const answer = await agent.run("fix tmp/game.js")
    expect(answer).toContain("Repeated incomplete/blocked mutation failures on tmp/game.js")
  })

  it("aborts after repeated replace_in_file old_string misses on the same artifact", async () => {
    const replaceInFileTool: Tool = {
      name: "replace_in_file",
      description: "Replace text in a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" }
        },
        required: ["path", "old_string", "new_string"]
      },
      async execute(args) {
        return `Error: old_string not found in "${String(args.path)}". The text you provided does not exist in the file. Use read_file to see the current content first.`
      }
    }

    const readFileTool: Tool = {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      },
      async execute(args) {
        return `current contents of ${String(args.path)}`
      }
    }

    const llm = scriptedLLM([
      {
        content: null,
        toolCalls: [
          {
            id: "tc1",
            name: "replace_in_file",
            arguments: { path: "tmp/game.js", old_string: "A", new_string: "B" }
          }
        ]
      },
      {
        content: null,
        toolCalls: [{ id: "tc2", name: "read_file", arguments: { path: "tmp/game.js" } }]
      },
      {
        content: null,
        toolCalls: [
          {
            id: "tc3",
            name: "replace_in_file",
            arguments: { path: "tmp/game.js", old_string: "C", new_string: "D" }
          }
        ]
      },
      {
        content: null,
        toolCalls: [{ id: "tc4", name: "read_file", arguments: { path: "tmp/game.js" } }]
      },
      {
        content: null,
        toolCalls: [
          {
            id: "tc5",
            name: "replace_in_file",
            arguments: { path: "tmp/game.js", old_string: "E", new_string: "F" }
          }
        ]
      }
    ])

    const agent = new Agent(llm, [replaceInFileTool, readFileTool], {
      maxIterations: 8,
      verbose: false
    })

    const answer = await agent.run("repair tmp/game.js")
    expect(answer).toContain("Repeated replace_in_file old_string misses on tmp/game.js")
  })

  it("returns cancellation message when signal is aborted", async () => {
    const controller = new AbortController()
    controller.abort()

    const llm = scriptedLLM([{ content: "should not reach", toolCalls: [] }])

    const agent = new Agent(llm, [], {
      verbose: false,
      signal: controller.signal
    })
    const answer = await agent.run("anything")

    expect(answer).toContain("cancelled")
  })

  it("reaches maxIterations and returns fallback answer", async () => {
    // LLM always uses a tool, never exits
    const responses: LLMResponse[] = Array.from({ length: 10 }, (_, i) => ({
      content: null,
      toolCalls: [{ id: `tc${i}`, name: "echo", arguments: { text: `iter${i}` } }]
    }))

    const llm = scriptedLLM(responses)
    const agent = new Agent(llm, [echoTool()], {
      maxIterations: 5,
      verbose: false
    })
    const answer = await agent.run("loop forever")

    // Agent should exhaust iterations and return SOMETHING
    expect(typeof answer).toBe("string")
    expect(answer.length).toBeGreaterThan(0)
  })

  it("routes simple tasks directly without entering planner execution", async () => {
    const plannerTrace: Array<Record<string, unknown>> = []
    const llm = scriptedLLM([{ content: "done", toolCalls: [] }])

    const agent = new Agent(llm, [], {
      verbose: false,
      enablePlanner: true,
      plannerDelegateFn: async () => "unused",
      onPlannerTrace: (entry) => plannerTrace.push(entry)
    })

    const answer = await agent.run("simple task")

    expect(answer).toBe("done")
    expect(plannerTrace.map((entry) => entry.kind)).toEqual(["planner-decision", "direct_loop_fallback"])
    expect(plannerTrace[0]).toMatchObject({
      kind: "planner-decision",
      shouldPlan: false,
      route: "direct"
    })
    expect(plannerTrace[1]).toMatchObject({
      kind: "direct_loop_fallback",
      source: "planner_declined"
    })
  })
})

describe("onThinking trace semantics", () => {
  it("emits content only for pre-tool narration, not final text-only answers", async () => {
    const thinkingCalls: Array<{ content: string | null; toolCount: number }> = []
    const llm = scriptedLLM([
      {
        content: "Let me echo that for you.",
        toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hello" } }]
      },
      { content: "The echo returned hello.", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      onThinking: (content, toolCalls) => {
        thinkingCalls.push({ content, toolCount: toolCalls.length })
      }
    })

    const answer = await agent.run("echo hello")

    expect(answer).toBe("The echo returned hello.")
    expect(thinkingCalls).toHaveLength(2)
    expect(thinkingCalls[0]).toEqual({ content: "Let me echo that for you.", toolCount: 1 })
    expect(thinkingCalls[1]).toEqual({ content: null, toolCount: 0 })
  })
})

describe("onThinking trace semantics", () => {
  it("emits content only for pre-tool narration, not final text-only answers", async () => {
    const thinkingCalls: Array<{ content: string | null; toolCount: number }> = []
    const llm = scriptedLLM([
      {
        content: "Let me echo that for you.",
        toolCalls: [{ id: "tc1", name: "echo", arguments: { text: "hello" } }]
      },
      { content: "The echo returned hello.", toolCalls: [] }
    ])

    const agent = new Agent(llm, [echoTool()], {
      verbose: false,
      onThinking: (content, toolCalls) => {
        thinkingCalls.push({ content, toolCount: toolCalls.length })
      }
    })

    const answer = await agent.run("echo hello")

    expect(answer).toBe("The echo returned hello.")
    expect(thinkingCalls).toHaveLength(2)
    expect(thinkingCalls[0]).toEqual({ content: "Let me echo that for you.", toolCount: 1 })
    expect(thinkingCalls[1]).toEqual({ content: null, toolCount: 0 })
  })
})
