import { describe, expect, it } from "vitest"
import {
  captureVirtualScrollAnchor,
  scrollTopForVirtualAnchor,
} from "./virtual-list-anchor"

describe("virtual-list-anchor", () => {
  const rows = [
    { index: 0, start: 0, size: 400 },
    { index: 1, start: 400, size: 800 },
    { index: 2, start: 1200, size: 200 },
  ]

  it("captures the row under the viewport top", () => {
    expect(captureVirtualScrollAnchor(0, rows)).toEqual({ index: 0, offsetInItem: 0 })
    expect(captureVirtualScrollAnchor(450, rows)).toEqual({ index: 1, offsetInItem: 50 })
    expect(captureVirtualScrollAnchor(1300, rows)).toEqual({ index: 2, offsetInItem: 100 })
  })

  it("restores scrollTop from index + offset after remasure", () => {
    const anchor = { index: 1, offsetInItem: 50 }
    // Row 1 grew above — new start is 300 instead of 400.
    expect(scrollTopForVirtualAnchor(anchor, 300)).toBe(350)
    expect(scrollTopForVirtualAnchor(anchor, null)).toBeNull()
  })
})
