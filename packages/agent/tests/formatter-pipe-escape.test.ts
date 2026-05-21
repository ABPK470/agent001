import type sql from "mssql"
import { describe, expect, it } from "vitest"
import { formatResults } from "../src/tools/mssql/formatter.js"

function makeRs(rows: Array<Record<string, unknown>>): sql.IRecordSet<unknown> {
  // Vitest test stub — we don't need the IRecordSet metadata properties,
  // only `[0]` access (for columns) and `.length` / `.slice`. The cast is safe
  // because formatResults treats it as a row array.
  return rows as unknown as sql.IRecordSet<unknown>
}

describe("formatResults — pipe escaping", () => {
  it("escapes a literal `|` inside a string cell so column count is preserved", () => {
    const rs = makeRs([
      { client: "ACME", coverage: "COVERAGE UNMANAGED | SOUTH AFRICA" },
      { client: "BETA", coverage: "RBB Banker" },
    ])
    const out = formatResults([rs], [2])

    // The header has 1 unescaped `|`; each data row should have exactly 1 too.
    const lines = out.split("\n").filter((l) => l.includes("|") && !/^[-+\s|]+$/.test(l))
    expect(lines.length).toBeGreaterThanOrEqual(3) // header + 2 rows
    for (const line of lines) {
      const unescaped = line.replace(/\\\|/g, "")
      const pipes = (unescaped.match(/\|/g) ?? []).length
      expect(pipes).toBe(1) // exactly one separator between two columns
    }

    // The escaped pipe must be present in the output
    expect(out).toContain("COVERAGE UNMANAGED \\| SOUTH AFRICA")
  })

  it("does not touch NULL, Date, or object branches", () => {
    const rs = makeRs([
      { a: null, b: new Date("2025-01-15T00:00:00.000Z"), c: { x: 1 } },
    ])
    const out = formatResults([rs], [1])
    expect(out).toContain("NULL")
    expect(out).toContain("2025-01-15T00:00:00.000Z")
    expect(out).toContain('{"x":1}')
  })

  it("round-trips through a naive split-on-unescaped-pipe parser", () => {
    const rs = makeRs([{ client: "A|B|C", note: "x" }])
    const out = formatResults([rs], [1])
    const dataLine = out.split("\n").find((l) => l.includes("A\\|B\\|C"))!
    // Split on unescaped `|` and unescape — same logic as the UI renderers use.
    const cells = dataLine
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"))
    expect(cells).toEqual(["A|B|C", "x"])
  })
})
