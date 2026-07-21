import { describe, expect, it, vi } from "vitest"
import { MessageRole } from "../src/domain/enums/message.js"
import { ApprovalRequiredError } from "../src/domain/types/errors.js"
import { runTools } from "../src/runtime/run-a-goal/steps/run-tools.js"
import type { Tool } from "../src/domain/types/agent-types.js"
import { createAgentLoopState } from "../src/runtime/run-a-goal/state.js"

describe("runTools — approval park checkpoint", () => {
  it("snapshots messages via onStep before tools, and strips incomplete toolCalls on ApprovalRequiredError", async () => {
    const onStep = vi.fn()
    const messages = [
      { role: MessageRole.User, content: "do the thing", section: "history" as const },
    ]
    const blocked = new ApprovalRequiredError(
      "run-1",
      "step-1",
      "fetch_url",
      { url: "https://example.com" },
      "needs approval",
      "policy",
    )
    const tool: Tool = {
      name: "fetch_url",
      description: "fetch",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw blocked
      },
    }
    const tools = new Map([["fetch_url", tool]])

    await expect(
      runTools({
        response: {
          content: null,
          toolCalls: [{ id: "tc-1", name: "fetch_url", arguments: { url: "https://example.com" } }],
        },
        messages,
        iteration: 0,
        state: createAgentLoopState(10),
        tools,
        toolList: [tool],
        userGoal: "do the thing",
        config: {
          verbose: false,
          onStep,
          toolCallTimeoutMs: 0,
          maxToolRetries: 0,
        } as never,
        allToolCalls: [],
      }),
    ).rejects.toBe(blocked)

    expect(onStep).toHaveBeenCalled()
    const snap = onStep.mock.calls[0]![0] as typeof messages
    expect(snap).toHaveLength(1)
    expect(snap[0]?.role).toBe(MessageRole.User)
    // Incomplete assistant tool-call must not remain on the live messages array.
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe(MessageRole.User)
  })
})
