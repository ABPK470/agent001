import { describe, expect, it } from "vitest"
import { fitVisibleViewIds, globalReorderIndex } from "./view-tab-overflow"

describe("fitVisibleViewIds", () => {
  const items = [
    { id: "a", widthPx: 80 },
    { id: "b", widthPx: 80 },
    { id: "c", widthPx: 80 },
    { id: "d", widthPx: 80 },
  ]

  it("returns all ids when everything fits", () => {
    expect(fitVisibleViewIds(items, "b", 400, 4, 64)).toEqual(["a", "b", "c", "d"])
  })

  it("never mid-clips — only whole chips, keeps active visible", () => {
    // budget 250, more 64 → usable 186 → active + one left neighbor
    expect(fitVisibleViewIds(items, "c", 250, 4, 64)).toEqual(["b", "c"])
  })

  it("keeps only active when nothing else fits", () => {
    expect(fitVisibleViewIds(items, "d", 100, 4, 64)).toEqual(["d"])
  })
})

describe("globalReorderIndex", () => {
  it("maps a strip-local drop into the full list", () => {
    const all = ["a", "b", "c", "d", "e"]
    const strip = ["b", "c", "d"]
    // drag d to start of strip → [d, b, c] visible → full [a, d, b, c, e]
    expect(globalReorderIndex(all, strip, "d", 0)).toBe(1)
  })

  it("handles drop at end of strip", () => {
    const all = ["a", "b", "c", "d"]
    const strip = ["a", "b", "c"]
    // drag a to end of strip among remaining [b,c] → slot 2 → [b, c, a]
    expect(globalReorderIndex(all, strip, "a", 2)).toBe(2)
  })
})
