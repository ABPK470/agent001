import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "VirtualList.tsx"),
  "utf8",
)

describe("VirtualList sticky contract", () => {
  it("positions rows with top — never transform (CSS sticky-safe)", () => {
    expect(src).toMatch(/top:\s*virtualRow\.start/)
    expect(src).not.toMatch(/transform:\s*`translateY/)
    expect(src).toMatch(/never `transform`/)
  })
})

describe("VirtualList resize scroll adjust", () => {
  it("exposes adjustScrollOnResize → shouldAdjustScrollPositionOnItemSizeChange", () => {
    // Trace sets false so fold height changes do not yank scrollTop.
    expect(src).toMatch(/adjustScrollOnResize\s*=\s*true/)
    expect(src).toContain(
      "shouldAdjustScrollPositionOnItemSizeChange: adjustScrollOnResize",
    )
  })
})

describe("VirtualList inspect anchor", () => {
  it("exposes capture/restore scroll anchor by row index", () => {
    expect(src).toContain("captureScrollAnchor")
    expect(src).toContain("restoreScrollAnchor")
    expect(src).toContain("captureVirtualScrollAnchor")
  })
})

describe("VirtualList sync resize", () => {
  it("exposes resizeItem for pre-paint size pushes (inline expand)", () => {
    expect(src).toContain("resizeItem")
    expect(src).toContain("virtualizer.resizeItem")
  })
})

describe("VirtualList append / measure contract", () => {
  it("never calls virtualizer.measure() on items.length (wipes size cache → overlap)", () => {
    // TanStack measure() clears itemSizeCache. On chat append that collapsed
    // every turn back to ~160px estimate — absolute rows painted over each other
    // and Nth runs never got real scroll space until remount.
    // Strip comments so the doc string mentioning measure() does not false-positive.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(code).not.toMatch(/virtualizer\.measure\s*\(/)
    expect(src).toMatch(/Do NOT call virtualizer\.measure/)
  })
})

/**
 * Pure offset math — what VirtualList must preserve across appends.
 * If measured sizes are wiped to estimate, starts collapse and rows overlap.
 */
function cumulativeStarts(sizes: number[]): number[] {
  const starts: number[] = []
  let offset = 0
  for (const size of sizes) {
    starts.push(offset)
    offset += size
  }
  return starts
}

describe("virtual row offsets after append", () => {
  it("keeps prior measured height when a new turn is appended", () => {
    const afterFirstMeasured = [4200]
    expect(cumulativeStarts(afterFirstMeasured)).toEqual([0])

    // Second goal append — must NOT reset first turn to estimate 160.
    const afterSecond = [4200, 160]
    expect(cumulativeStarts(afterSecond)).toEqual([0, 4200])
    expect(afterSecond.reduce((a, b) => a + b, 0)).toBe(4360)

    const wipedToEstimate = [160, 160]
    expect(cumulativeStarts(wipedToEstimate)).toEqual([0, 160])
    // Wiped layout parks run 2 inside run 1's real 4200px overflow.
    expect(cumulativeStarts(wipedToEstimate)[1]).toBeLessThan(4200)
  })
})
