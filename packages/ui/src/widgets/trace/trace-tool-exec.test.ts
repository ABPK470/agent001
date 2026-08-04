import { describe, expect, it } from "vitest"
import {
  buildExecSummary,
  chatToolPillText,
  chatToolVerb,
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
    expect(summary.name).toBe("query_mssql")
    expect(summary.detail).toBe("10 rows returned")
    expect(summary.duration).toBe("220ms")
  })

  it("uses Blocked verb for gate errors", () => {
    expect(
      execStatusVerb("error", "Blocked before send — MISSING_WHERE"),
    ).toBe("Blocked")
  })

  it("extracts error codes from parentheses or trailing colon form", () => {
    expect(execErrorCode("Blocked before send (MISSING_WHERE)")).toBe(
      "MISSING_WHERE",
    )
    expect(execErrorCode("Blocked by SQL quality: MISSING_WHERE")).toBe(
      "MISSING_WHERE",
    )
  })

  it("prefers short error code in collapsed summary detail", () => {
    const summary = buildExecSummary({
      toolName: "query_mssql",
      status: "error",
      argumentsValue: { sql: "select 1" },
      argsFormatted: '{"sql":"select 1"}',
      resultText: null,
      errorText: "Blocked by SQL quality: MISSING_WHERE",
      durationMs: 2200,
    })
    expect(summary.verb).toBe("Blocked")
    expect(summary.detail).toBe("MISSING_WHERE")
  })

  it("uses Copilot-style chat verbs and pill truncation", () => {
    expect(chatToolVerb("run_command", "done")).toBe("Ran")
    expect(chatToolVerb("query_mssql", "done")).toBe("Queried")
    expect(chatToolVerb("list_environments", "done")).toBe("Listed")
    expect(chatToolVerb("query_mssql", "error", "Blocked by SQL quality: MISSING_WHERE")).toBe(
      "Blocked",
    )
    expect(chatToolPillText("SELECT TOP 10 id FROM clients WHERE active = 1", null, 20)).toBe(
      "SELECT TOP 10 id FR…",
    )
  })

  it("omits empty JSON args from expanded input", () => {
    const empty = formatExecInput("list_environments", {}, "{}")
    expect(empty.text).toBe("")
    const cmd = formatExecInput(
      "run_command",
      { command: "npm run build" },
      '{"command":"npm run build"}',
    )
    expect(cmd.text).toBe("npm run build")
  })
})
