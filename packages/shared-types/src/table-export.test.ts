import { describe, expect, it } from "vitest"
import {
  extractAnswerTables,
  resolveTablesForExport,
  serializeAnswerTableCsv,
  serializeAnswerTablesJson,
} from "./table-export.js"

const SAMPLE = `# Revenue

| Region | Amount |
| --- | --- |
| APAC | 10 |
| EMEA | 20 |

Some prose.

## Users

| Id | Name |
| --- | --- |
| 1 | Ada |
| 2 | Bob |
`

describe("extractAnswerTables", () => {
  it("extracts markdown tables with preceding headings as titles", () => {
    const tables = extractAnswerTables(SAMPLE)
    expect(tables).toHaveLength(2)
    expect(tables[0]).toMatchObject({
      index: 0,
      title: "Revenue",
      headers: ["Region", "Amount"],
      rows: [
        ["APAC", "10"],
        ["EMEA", "20"],
      ],
    })
    expect(tables[1]).toMatchObject({
      index: 1,
      title: "Users",
      headers: ["Id", "Name"],
    })
  })

  it("skips fenced code that looks like tables", () => {
    const tables = extractAnswerTables("```\n| A |\n| - |\n| 1 |\n```\n\n| B |\n| - |\n| 2 |\n")
    expect(tables).toHaveLength(1)
    expect(tables[0].headers).toEqual(["B"])
  })
})

describe("serializeAnswerTableCsv", () => {
  it("escapes commas and quotes", () => {
    const csv = serializeAnswerTableCsv({
      headers: ["Name", "Note"],
      rows: [["Ada, A", 'Said "hi"']],
    })
    expect(csv).toBe('Name,Note\n"Ada, A","Said ""hi"""')
  })
})

describe("resolveTablesForExport", () => {
  it("requires exactly one table for CSV", () => {
    const result = resolveTablesForExport(SAMPLE, { format: "csv", tableIndexes: [0, 1] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/exactly one table/)
  })

  it("returns selected tables for JSON", () => {
    const result = resolveTablesForExport(SAMPLE, { format: "json", tableIndexes: [1, 0] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tables.map((t) => t.index)).toEqual([1, 0])
    const json = JSON.parse(serializeAnswerTablesJson("run-1", result.tables))
    expect(json.runId).toBe("run-1")
    expect(json.tables).toHaveLength(2)
  })

  it("rejects unknown indexes", () => {
    const result = resolveTablesForExport(SAMPLE, { format: "csv", tableIndexes: [9] })
    expect(result.ok).toBe(false)
  })
})
