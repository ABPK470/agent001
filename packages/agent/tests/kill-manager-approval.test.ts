import { describe, expect, it, vi } from "vitest"
import { ApprovalRequiredError } from "../src/domain/index.js"
import { asToolCallId } from "../src/domain/types/branded-ids.js"
import type { Tool, ToolKillManager } from "../src/domain/types/agent-types.js"
import { executeWithKillManager } from "../src/runtime/loop/tool-execution/kill-manager.js"

describe("executeWithKillManager", () => {
  it("clears kill registration without completed when ApprovalRequiredError is thrown", async () => {
    const unregister = vi.fn()
    const killManager: ToolKillManager = {
      register: () => new Promise(() => {}),
      unregister,
    }
    const tool: Tool = {
      name: "fetch_url",
      description: "fetch",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw new ApprovalRequiredError(
          "run-1",
          "step-1",
          "fetch_url",
          { url: "https://example.com" },
          "needs approval",
          "http"
        )
      },
    }

    await expect(
      executeWithKillManager(
        { id: "tc-1", name: "fetch_url", arguments: { url: "https://example.com" } },
        tool,
        {
          signal: undefined,
          toolKillManager: killManager,
          iteration: 1,
        }
      )
    ).rejects.toBeInstanceOf(ApprovalRequiredError)

    expect(unregister).toHaveBeenCalledWith(asToolCallId("tc-1"), { completed: false })
  })
})
