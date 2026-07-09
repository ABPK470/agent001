import { describe, expect, it } from "vitest"
import {
  presentToolCall,
  presentToolCallFromFormatted,
  serializeToolCallArgs,
  stripRuntimeToolArgs,
  TOOL_TRACE_ARG
} from "@mia/shared-types"

describe("tool-call-presentation", () => {
  it("strips runtime-only args", () => {
    const clean = stripRuntimeToolArgs({
      search: "orders",
      [TOOL_TRACE_ARG]: { toolCallId: "x", toolName: "search_catalog", iteration: 1 }
    })
    expect(clean).toEqual({ search: "orders" })
    expect(serializeToolCallArgs({ search: "orders", [TOOL_TRACE_ARG]: {} })).toBe(
      '{\n  "search": "orders"\n}'
    )
  })

  it("formats search_catalog like an invocation, not raw JSON", () => {
    const presentation = presentToolCall("search_catalog", { search: "Customer" })
    expect(presentation.summary).toBe('search="Customer"')
    expect(presentation.display).toBe("search: Customer")
    expect(presentation.artifact).toBeNull()
  })

  it("shows run_command body as the primary artifact", () => {
    const presentation = presentToolCall("run_command", { command: "ls -la" })
    expect(presentation.display).toBe("ls -la")
    expect(presentation.artifact?.lang).toBe("sh")
  })

  it("re-presents persisted JSON args", () => {
    const argsFormatted = serializeToolCallArgs({ pattern: "foo", path: "src" })
    const presentation = presentToolCallFromFormatted("search_files", argsFormatted)
    expect(presentation.display).toContain("pattern: foo")
    expect(presentation.display).toContain("path: src")
    expect(presentation.display).not.toContain(TOOL_TRACE_ARG)
  })
})
