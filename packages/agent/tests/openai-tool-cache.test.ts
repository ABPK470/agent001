/**
 * Gap 1: tool schema formatting cache reuses the same OpenAI tool array
 * across multiple chat calls when the input `Tool[]` reference is identical.
 */
import { describe, expect, it } from "vitest"
import { __internal } from "../src/llm/openai.js"
import type { Tool } from "../src/domain/agent-types.js"

const tools: Tool[] = [
  {
    name: "echo",
    description: "Echo a value",
    parameters: { type: "object", properties: { v: { type: "string" } }, required: ["v"] },
    handler: async (a) => String(a.v)
  }
]

describe("openai tool schema cache (Gap 1)", () => {
  it("returns the same formatted array on repeated calls with identical input ref", () => {
    const a = __internal.formatTools(tools)
    const b = __internal.formatTools(tools)
    expect(b).toBe(a)
    expect(__internal.formattedToolCache.has(tools)).toBe(true)
  })
  it("rebuilds for a different array reference even if shape is identical", () => {
    const a = __internal.formatTools(tools)
    const cloned = [...tools]
    const b = __internal.formatTools(cloned)
    expect(b).not.toBe(a)
    // But content equivalent
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })
})
