import { describe, expect, it } from "vitest"
import { formatErrorLinePointer, parseErrorTrace } from "./trace-error-parse"

describe("parseErrorTrace", () => {
  it("extracts at-line pointers", () => {
    const parsed = parseErrorTrace("Syntax error at line 12: unexpected token")
    expect(parsed.headline).toBe("Syntax error at line 12: unexpected token")
    expect(parsed.lines).toEqual([{ lineNumber: 12, text: "unexpected token" }])
  })

  it("extracts stack frame line numbers", () => {
    const parsed = parseErrorTrace(
      "Error: boom\n    at query (/app/sql.ts:42:5)\n    at run (/app/run.ts:10:3)",
    )
    expect(parsed.lines.some((l) => l.lineNumber === 42)).toBe(true)
    expect(parsed.lines.some((l) => l.lineNumber === 10)).toBe(true)
  })

  it("formats line pointers", () => {
    expect(formatErrorLinePointer({ lineNumber: 3, text: "bad column" })).toBe(
      "At line 3: bad column",
    )
  })
})
