import { describe, expect, it } from "vitest"
import {
  buildExecSummary,
  execErrorCode,
  execStatusVerb,
  formatExecInput,
} from "../../lib/tool-execution"

describe("tool-execution", () => {
  it("formats SQL input from args", () => {
    const input = formatExecInput(
      "query_mssql",
      { sql: "SELECT TOP 10 id FROM clients" },
      '{"sql":"SELECT TOP 10 id FROM clients"}',
    )
    expect(input.text).toContain("SELECT TOP 10")
    expect(input.lang).toBe("sql")
  })

  it("builds collapsed success summary", () => {
    const summary = buildExecSummary({
      toolName: "query_mssql",
      status: "done",
      argumentsValue: { sql: "select 1" },
      argsFormatted: '{"sql":"select 1"}',
      resultText: "10 rows returned",
      errorText: null,
      durationMs: 220,
    })
    expect(summary.verb).toBe("Executed")
    expect(summary.name).toBe("query mssql")
    expect(summary.detail).toBe("10 rows returned")
    expect(summary.duration).toBe("220ms")
  })

  it("uses Blocked verb for gate errors", () => {
    expect(
      execStatusVerb("error", "Blocked before send — MISSING_WHERE"),
    ).toBe("Blocked")
  })

  it("extracts error codes from parentheses", () => {
    expect(execErrorCode("Blocked before send (MISSING_WHERE)")).toBe(
      "MISSING_WHERE",
    )
  })
})
