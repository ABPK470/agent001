/**
 * onToolResult granularity — verifies the hook fires once per tool call and
 * receives the live `messages` array with the just-appended tool result. This
 * is the contract the server-side `writeRunCheckpoint` rides to make resume
 * tool-call granular (snapshot after every tool call, not just per iteration).
 */

import { describe, expect, it, vi } from "vitest"
import { Agent } from "../src/application/shell/agent.js"
import { MessageRole } from "../src/domain/enums/message.js"
import type { LLMClient, LLMResponse, Tool } from "../src/domain/agent-types.js"

describe("onToolResult granularity", () => {
  it("fires once per tool call and includes the just-appended tool result in messages", async () => {
    const responses: LLMResponse[] = [
      { content: "first call", toolCalls: [{ id: "tc-1", name: "echo", arguments: { text: "one" } }] },
      { content: "second call", toolCalls: [{ id: "tc-2", name: "echo", arguments: { text: "two" } }] },
      { content: "done", toolCalls: [] }
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

    const seen: {
      toolCallId: string
      messageCount: number
      hasOwnResult: boolean
    }[] = []
    const agent = new Agent(llm, [echo], {
      verbose: false,
      onToolResult: (data) => {
        seen.push({
          toolCallId: data.toolCallId,
          messageCount: data.messages.length,
          hasOwnResult: data.messages.some(
            (m) => m.role === MessageRole.Tool && m.toolCallId === data.toolCallId
          )
        })
      }
    })

    await agent.run("Echo two things")

    // Fired exactly once per tool call — this is the granularity contract.
    expect(seen.map((s) => s.toolCallId)).toEqual(["tc-1", "tc-2"])
    // Each firing saw the live messages INCLUDING its own just-appended result,
    // so a checkpoint taken here resumes from after that tool call.
    expect(seen.every((s) => s.hasOwnResult)).toBe(true)
    // Progress grew monotonically across the two calls.
    expect(seen[1]!.messageCount).toBeGreaterThan(seen[0]!.messageCount)
  })

  it("passes messages for error tool results too (so a failed tool call is still a checkpoint point)", async () => {
    const responses: LLMResponse[] = [
      { content: "boom call", toolCalls: [{ id: "tc-err", name: "boom", arguments: {} }] },
      { content: "done", toolCalls: [] }
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
    const boom: Tool = {
      name: "boom",
      description: "Always fails",
      parameters: { type: "object", properties: {}, required: [] },
      async execute() {
        throw new Error("kaboom")
      }
    }

    const seen: { toolCallId: string; isError: boolean; hasOwnResult: boolean }[] = []
    const agent = new Agent(llm, [boom], {
      verbose: false,
      onToolResult: (data) => {
        seen.push({
          toolCallId: data.toolCallId,
          isError: data.isError,
          hasOwnResult: data.messages.some(
            (m) => m.role === MessageRole.Tool && m.toolCallId === data.toolCallId
          )
        })
      }
    })

    await agent.run("Trigger the boom")

    expect(seen).toHaveLength(1)
    expect(seen[0]!.toolCallId).toBe("tc-err")
    expect(seen[0]!.isError).toBe(true)
    expect(seen[0]!.hasOwnResult).toBe(true)
  })
})
