import { describe, expect, it } from "vitest"
import {
  buildLineTextDiff,
  collapseUnchangedDiffRows,
  materializeCollapsedDiffRows,
} from "./line-text-diff"

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

  it("attaches hiddenRows and a stable id so each gap can expand independently", () => {
    const rows = buildLineTextDiff(
      Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n"),
      Array.from({ length: 30 }, (_, i) => (i === 15 ? "changed" : `line-${i}`)).join("\n"),
    )
    const collapsed = collapseUnchangedDiffRows(rows, 1)
    const gaps = collapsed.filter((row) => row.kind === "ellipsis")
    // One gap above the change, one below — both expandable.
    expect(gaps.length).toBeGreaterThanOrEqual(2)
    for (const gap of gaps) {
      expect(gap.id).toBeTruthy()
      expect(gap.hiddenRows?.length).toBe(gap.omitted)
      expect(gap.hiddenRows?.every((row) => row.kind === "same")).toBe(true)
      expect(gap.text).toMatch(/^Show \d+ unchanged lines?$/)
    }
    expect(new Set(gaps.map((g) => g.id)).size).toBe(gaps.length)
  })
})

describe("materializeCollapsedDiffRows", () => {
  it("reveals hidden rows for expanded gaps and keeps others collapsed", () => {
    const rows = buildLineTextDiff(
      Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n"),
      Array.from({ length: 30 }, (_, i) => (i === 15 ? "changed" : `line-${i}`)).join("\n"),
    )
    const collapsed = collapseUnchangedDiffRows(rows, 1)
    const firstGap = collapsed.find((row) => row.kind === "ellipsis")
    expect(firstGap?.id).toBeTruthy()

    const materialized = materializeCollapsedDiffRows(
      collapsed,
      new Set([firstGap!.id!]),
    )
    expect(materialized.some((row) =>
      row.kind === "ellipsis" && row.id === firstGap!.id && row.text.startsWith("Hide "),
    )).toBe(true)
    expect(
      materialized.filter((row) => row.kind === "same").length,
    ).toBeGreaterThan(
      collapsed.filter((row) => row.kind === "same").length,
    )

    // Other gaps stay collapsed.
    const otherGaps = materialized.filter(
      (row) => row.kind === "ellipsis" && row.id !== firstGap!.id,
    )
    expect(otherGaps.every((row) => row.text.startsWith("Show "))).toBe(true)
  })

  it("collapsing again removes revealed lines", () => {
    const rows = buildLineTextDiff(
      Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"),
      Array.from({ length: 20 }, (_, i) => (i === 10 ? "x" : `line-${i}`)).join("\n"),
    )
    const collapsed = collapseUnchangedDiffRows(rows, 1)
    const gap = collapsed.find((row) => row.kind === "ellipsis")!
    const open = materializeCollapsedDiffRows(collapsed, new Set([gap.id!]))
    const closed = materializeCollapsedDiffRows(collapsed, new Set())
    expect(open.length).toBeGreaterThan(closed.length)
    expect(closed.filter((row) => row.kind === "ellipsis").length).toBe(
      collapsed.filter((row) => row.kind === "ellipsis").length,
    )
  })
})
