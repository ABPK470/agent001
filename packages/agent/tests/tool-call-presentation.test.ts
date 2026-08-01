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

  it("treats legacy query_mssql `sql` arg as the SQL artifact", () => {
    const presentation = presentToolCall("query_mssql", { sql: "SELECT * FROM HugeTable" })
    expect(presentation.artifact?.lang).toBe("sql")
    expect(presentation.artifact?.code).toBe("SELECT * FROM HugeTable")
    expect(presentation.display).toBe("SELECT * FROM HugeTable")
  })

  it("treats raw SQL argsFormatted as a code artifact", () => {
    const presentation = presentToolCallFromFormatted("query_mssql", "SELECT * FROM HugeTable")
    expect(presentation.artifact?.lang).toBe("sql")
    expect(presentation.artifact?.code).toBe("SELECT * FROM HugeTable")
  })

  it("does not invent a SQL CodeBlock from tool result prose", () => {
    expect(presentToolCallFromFormatted("query_mssql", "10 rows returned").artifact).toBeNull()
    expect(
      presentToolCallFromFormatted(
        "query_mssql",
        "Blocked before send (MISSING_WHERE) — query needs a tighter filter."
      ).artifact
    ).toBeNull()
  })

  it("presents ask_user question as plain display (Input pane, not SQL)", () => {
    const presentation = presentToolCall("ask_user", { question: "Which brand colors?" })
    expect(presentation.artifact).toBeNull()
    expect(presentation.display).toBe("Which brand colors?")
    expect(presentation.summary).toContain("Which brand colors?")
  })

  it("re-presents persisted JSON args", () => {
    const argsFormatted = serializeToolCallArgs({ pattern: "foo", path: "src" })
    const presentation = presentToolCallFromFormatted("search_files", argsFormatted)
    expect(presentation.display).toContain("pattern: foo")
    expect(presentation.display).toContain("path: src")
    expect(presentation.display).not.toContain(TOOL_TRACE_ARG)
  })
})
