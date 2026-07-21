import { describe, expect, it } from "vitest"
import { formatToolArgs, formatToolOutput } from "./toolFormat.js"

describe("AgentChat tool I/O formatting", () => {
  it("renders args as key=value pairs", () => {
    expect(formatToolArgs({})).toBe("")
    expect(formatToolArgs({ path: "a.ts", n: 2, ok: true, missing: null })).toBe(
      'path="a.ts" n=2 ok=true missing=null',
    )
    expect(formatToolArgs({ nested: { a: 1 } })).toContain('nested={"a":1}')
  })

  it("prefers output.result and surfaces errors", () => {
    expect(formatToolOutput({ result: "ok" }, null)).toBe("ok")
    expect(formatToolOutput({ result: 3 }, null)).toBe("3")
    expect(formatToolOutput({}, "boom")).toBe("boom")
    expect(formatToolOutput({ a: 1 }, null)).toContain('"a": 1')
  })
})
