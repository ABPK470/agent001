import { describe, expect, it, vi } from "vitest"
import { Agent } from "../src/runtime/agent.js"
import type { LLMClient, LLMResponse, Tool } from "../src/domain/models/agent-types.js"
import { synthesizeFinalAnswer } from "../src/runtime/run-a-goal/agent-helpers.js"
import {
  createAnswerStreamGate,
  emitAnswerChunks,
  emitAnswerChunksPaced
} from "../src/runtime/run-a-goal/answer-stream-gate.js"

describe("emitAnswerChunks", () => {
  it("emits fixed-size chunks", () => {
    const chunks: string[] = []
    emitAnswerChunks("a".repeat(100), (c) => chunks.push(c))
    expect(chunks.join("")).toBe("a".repeat(100))
  })
})

describe("emitAnswerChunksPaced", () => {
  it("emits all text over multiple ticks", async () => {
    const chunks: string[] = []
    await emitAnswerChunksPaced("a".repeat(100), (c) => chunks.push(c), 0)
    expect(chunks.join("")).toBe("a".repeat(100))
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe("createAnswerStreamGate", () => {
  it("buffers silently before tools have run", () => {
    const onToken = vi.fn()
    const gate = createAnswerStreamGate({ allowLiveStream: false, onToken })

    gate.onTokenDelta("I'll query ")
    gate.onTokenDelta("the database")
    expect(onToken).not.toHaveBeenCalled()
  })

  it("paced-flushes buffered text on approval", async () => {
    const onToken = vi.fn()
    const gate = createAnswerStreamGate({ allowLiveStream: false, onToken })

    gate.onTokenDelta("Hello world")
    await gate.flushApproved("Hello world")
    expect(onToken).toHaveBeenCalled()
    expect(onToken.mock.calls.map((c) => c[0]).join("")).toBe("Hello world")
  })

  it("discards buffered prose without resetting the UI when tool calls start", () => {
    const onToken = vi.fn()
    const onStreamDiscard = vi.fn()
    const gate = createAnswerStreamGate({
      allowLiveStream: false,
      onToken,
      onStreamDiscard
    })

    gate.onTokenDelta("I'll query the database")
    gate.onToolCallStarted()

    expect(onToken).not.toHaveBeenCalled()
    expect(onStreamDiscard).not.toHaveBeenCalled()
  })

  it("streams live after tools have run", () => {
    const onToken = vi.fn()
    const gate = createAnswerStreamGate({ allowLiveStream: true, onToken })

    gate.onTokenDelta("Live ")
    gate.onTokenDelta("token")
    expect(onToken).toHaveBeenCalledTimes(2)

    gate.flushApproved("Live token")
    expect(onToken).toHaveBeenCalledTimes(2)
  })

  it("clears live stream when tool calls start mid-answer", () => {
    const onToken = vi.fn()
    const onStreamDiscard = vi.fn()
    const gate = createAnswerStreamGate({
      allowLiveStream: true,
      onToken,
      onStreamDiscard
    })

    gate.onTokenDelta("Partial answer")
    gate.onToolCallStarted()

    expect(onStreamDiscard).toHaveBeenCalledTimes(1)
    gate.onTokenDelta("more")
    expect(onToken).toHaveBeenCalledTimes(1)
  })

  it("discard clears on guard rejection", () => {
    const onToken = vi.fn()
    const onStreamDiscard = vi.fn()
    const gate = createAnswerStreamGate({
      allowLiveStream: true,
      onToken,
      onStreamDiscard
    })

    gate.onTokenDelta("Draft")
    gate.discard()
    expect(onStreamDiscard).toHaveBeenCalledTimes(1)
  })

  it("never resets visible text when final content reconciliation differs", async () => {
    const onToken = vi.fn()
    const onStreamDiscard = vi.fn()
    const gate = createAnswerStreamGate({
      allowLiveStream: true,
      onToken,
      onStreamDiscard
    })

    gate.onTokenDelta("Visible answer")
    await gate.flushApproved("Different provider content")

    expect(onStreamDiscard).not.toHaveBeenCalled()
    expect(onToken.mock.calls.map((c) => c[0]).join("")).toBe("Visible answer")
  })
})

describe("agent answer visibility invariant", () => {
  it("never exposes prose from later iterations that still call tools", async () => {
    const responses: LLMResponse[] = [
      {
        content: "I will inspect first.",
        toolCalls: [{ id: "tc-1", name: "echo", arguments: { text: "one" } }]
      },
      {
        content: "I need one more check.",
        toolCalls: [{ id: "tc-2", name: "echo", arguments: { text: "two" } }]
      },
      { content: "Final answer.", toolCalls: [] }
    ]
    let call = 0
    const llm: LLMClient = {
      async chat(_messages, _tools, options) {
        const response = responses[call++]!
        if (response.content) options?.onToken?.(response.content)
        if (response.toolCalls.length > 0) options?.onFirstToolCallDelta?.()
        return response
      }
    }
    const echo: Tool = {
      name: "echo",
      description: "Echo text",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"]
      },
      async execute(args) {
        return String(args.text)
      }
    }
    const visible: string[] = []
    const resets = vi.fn()
    const agent = new Agent(llm, [echo], {
      verbose: false,
      onToken: (token) => visible.push(token),
      onStreamDiscard: resets
    })

    const answer = await agent.run("Inspect twice and report")

    expect(answer).toBe("Final answer.")
    expect(visible.join("")).toBe("Final answer.")
    expect(resets).not.toHaveBeenCalled()
  })

  it("does not expose a partial synthesis when the provider fails", async () => {
    const visible: string[] = []
    const llm: LLMClient = {
      async chat(_messages, _tools, options) {
        options?.onToken?.("Partial synthesis that must not be shown")
        throw new Error("provider disconnected")
      }
    }

    const answer = await synthesizeFinalAnswer(
      {
        llm,
        signal: undefined,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        incrementLlmCalls: () => {},
        onToken: (token) => visible.push(token)
      },
      []
    )

    expect(answer).toBe("(The agent was unable to produce a final answer.)")
    expect(visible.join("")).toBe(answer)
  })
})
