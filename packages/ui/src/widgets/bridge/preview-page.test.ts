import { describe, expect, it } from "vitest"
import { PREVIEW_PAGE_SIZE, previewPageSlice } from "./preview-page"

describe("previewPageSlice", () => {
  const rows = Array.from({ length: 23 }, (_, i) => ({ i }))

  it("pages at PREVIEW_PAGE_SIZE", () => {
    expect(PREVIEW_PAGE_SIZE).toBe(10)
    const first = previewPageSlice(rows, 0)
    expect(first.pageCount).toBe(3)
    expect(first.start).toBe(0)
    expect(first.end).toBe(10)
    expect(first.rows).toHaveLength(10)
  })

  it("returns the last partial page", () => {
    const last = previewPageSlice(rows, 2)
    expect(last.start).toBe(20)
    expect(last.end).toBe(23)
    expect(last.rows).toHaveLength(3)
  })

  it("clamps an out-of-range page", () => {
    expect(previewPageSlice(rows, 99).page).toBe(2)
    expect(previewPageSlice(rows, -1).page).toBe(0)
  })

  it("handles an empty set", () => {
    expect(previewPageSlice([], 0)).toEqual({
      page: 0,
      pageCount: 1,
      start: 0,
      end: 0,
      rows: [],
    })
  })
})
