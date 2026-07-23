import { describe, expect, it } from "vitest"
import {
  formatTraceExportText,
  stripCodeFromTraceEntry,
  stripCodeFromTraceText,
  traceExportFilename,
} from "./trace-export.js"

describe("stripCodeFromTraceText", () => {
  it("replaces fenced code blocks", () => {
    expect(stripCodeFromTraceText("before\n```sql\nSELECT 1\n```\nafter")).toBe(
      "before\n[code omitted]\nafter",
    )
  })
})

describe("formatTraceExportText omitCode", () => {
  it("omits system prompt and tool arg bodies", () => {
    const text = formatTraceExportText(
      [
        { kind: "system-prompt", text: "You are Mia. Prefer query_mssql." },
        {
          kind: "tool-call",
          tool: "query_mssql",
          argsSummary: "SELECT…",
          argsFormatted: "SELECT * FROM huge_table",
        },
        {
          kind: "tool-result",
          text: "ok\n```sql\nSELECT 1\n```\ndone",
        },
      ],
      { runId: "run-abc", status: "completed", totalTokens: 10, llmCalls: 1 },
      { omitCode: true },
    )
    expect(text).toContain("mode=no-code")
    expect(text).toContain("SYSTEM PROMPT  [omitted — --no-code]")
    expect(text).toContain("TOOL CALL  query_mssql  SELECT…")
    expect(text).not.toContain("SELECT * FROM huge_table")
    expect(text).toContain("[code omitted]")
  })
})

describe("stripCodeFromTraceEntry", () => {
  it("drops argsFormatted on tool-call", () => {
    const next = stripCodeFromTraceEntry({
      kind: "tool-call",
      tool: "inspect_definition",
      argsSummary: "depends_on=publish.Revenue",
      argsFormatted: "FULL BODY",
    })
    expect(next["argsFormatted"]).toBeUndefined()
    expect(next["argsSummary"]).toBe("depends_on=publish.Revenue")
  })
})

describe("traceExportFilename", () => {
  it("tags nocode exports", () => {
    expect(traceExportFilename("abcdefgh-ijkl", "txt", { omitCode: true })).toMatch(
      /agent-loop-.*-abcdefgh-nocode\.txt$/,
    )
  })
})
