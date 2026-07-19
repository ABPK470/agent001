import { describe, expect, it } from "vitest"
import { buildLineTextDiff, collapseUnchangedDiffRows } from "./line-text-diff"

describe("buildLineTextDiff", () => {
  it("marks added and removed lines", () => {
    const rows = buildLineTextDiff(
      '{\n  "id": "a",\n  "name": "old"\n}',
      '{\n  "id": "a",\n  "name": "new"\n}',
    )
    expect(rows.some((row) => row.kind === "removed" && row.text.includes("old"))).toBe(true)
    expect(rows.some((row) => row.kind === "added" && row.text.includes("new"))).toBe(true)
    expect(rows.filter((row) => row.kind === "same").length).toBeGreaterThan(0)
  })
})

describe("collapseUnchangedDiffRows", () => {
  it("keeps change hunks and collapses long unchanged runs", () => {
    const rows = buildLineTextDiff(
      Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"),
      Array.from({ length: 20 }, (_, i) => (i === 10 ? "changed" : `line-${i}`)).join("\n"),
    )
    const collapsed = collapseUnchangedDiffRows(rows, 1)
    expect(collapsed.some((row) => row.kind === "ellipsis")).toBe(true)
    expect(collapsed.some((row) => row.kind === "removed" && row.text === "line-10")).toBe(true)
    expect(collapsed.some((row) => row.kind === "added" && row.text === "changed")).toBe(true)
    expect(collapsed.length).toBeLessThan(rows.length)
  })
})
