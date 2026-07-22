import { describe, expect, it } from "vitest"
import { pinBandScrollDelta } from "./pin-band-scroll.js"

const H = 34

describe("pinBandScrollDelta", () => {
  it("shrinks scrollTop when Call+Received band collapses (2 → 0)", () => {
    // Band lost 68px above the scroller — without this, wheel scroll is cancelled.
    expect(pinBandScrollDelta(2, 0, H)).toBe(-68)
  })

  it("grows scrollTop when Work pins after the empty handoff (0 → 1)", () => {
    expect(pinBandScrollDelta(0, 1, H)).toBe(34)
  })

  it("is zero when pin count is unchanged", () => {
    expect(pinBandScrollDelta(2, 2, H)).toBe(0)
  })
})
