import { describe, expect, it } from "vitest"
import { buildLineTextDiff } from "./line-text-diff"

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
