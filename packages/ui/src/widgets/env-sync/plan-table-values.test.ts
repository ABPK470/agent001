import { describe, expect, it } from "vitest"

import {
  formatCellFull,
  formatCellPreview,
  isCellPreviewTruncated,
  sampleRowColumns,
  sampleRowDetailSubtitle,
  sampleRowDetailTitle,
} from "./plan-table-values"

describe("plan-table-values", () => {
  it("preview truncates long strings with ellipsis after 77 characters", () => {
    const long = "a".repeat(100)
    const preview = formatCellPreview(long)
    expect(preview).toHaveLength(78)
    expect(preview.endsWith("…")).toBe(true)
    expect(preview.startsWith("a".repeat(77))).toBe(true)
  })

  it("preview leaves short strings and null unchanged", () => {
    expect(formatCellPreview(null)).toBe("null")
    expect(formatCellPreview("short")).toBe("short")
  })

  it("preview stringifies objects on one line without truncation", () => {
    const value = { description: "x".repeat(120), id: 1 }
    expect(formatCellPreview(value)).toBe(JSON.stringify(value))
    expect(isCellPreviewTruncated(value)).toBe(false)
  })

  it("full value never truncates strings", () => {
    const long = "b".repeat(500)
    expect(formatCellFull(long)).toBe(long)
    expect(formatCellFull(long).length).toBe(500)
  })

  it("full value pretty-prints JSON strings and objects", () => {
    const jsonText = '{"description":"Africa Flex daily balances","enabled":true}'
    expect(formatCellFull(jsonText)).toBe(JSON.stringify(JSON.parse(jsonText), null, 2))
    expect(formatCellFull({ enabled: true })).toBe('{\n  "enabled": true\n}')
  })

  it("full value keeps invalid JSON strings as-is", () => {
    const broken = '{"description": broken}'
    expect(formatCellFull(broken)).toBe(broken)
  })

  it("lists every column on a sample row in stable order", () => {
    expect(sampleRowColumns({
      oldValues: { b: 1, a: 2 },
      newValues: { c: 3, a: 4 },
    })).toEqual(["a", "b", "c"])
  })

  it("builds row modal titles and subtitles", () => {
    expect(sampleRowDetailTitle("update")).toBe("Update row")
    expect(sampleRowDetailSubtitle({
      table: "core.Contract",
      kind: "update",
      rowIndex: 0,
      sample: {},
    })).toBe("core.Contract · update · row 1")
  })
})
