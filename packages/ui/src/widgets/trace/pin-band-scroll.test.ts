import { describe, expect, it } from "vitest"
import { computePinnedFromEntries } from "./trace-pin.js"
import {
  pinBandScrollDelta,
  stabilizePinBandScrollTop,
} from "./pin-band-scroll.js"

const H = 34
const band = { stackInScroll: false as const }

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

describe("stabilizePinBandScrollTop — SENT/RECEIVED peer handoff", () => {
  /**
   * Image moment: Subagent → Call → SENT → USER pinned; RECEIVED just below.
   * Scrolling a few px makes RECEIVED take SENT's peer slot (4 → 3 pins).
   * Naive −rowH compensation pulls scrollTop back under RECEIVED.top and
   * SENT+USER re-pin — infinite flicker.
   */
  const tree = [
    { id: "phase-sub", top: 0, depth: 0 },
    { id: "call:0", top: 40, depth: 1 },
    { id: "sent:0", top: 80, depth: 2 },
    { id: "message:0:m:0", top: 120, depth: 3 }, // USER
    { id: "received:0", top: 500, depth: 2 },
  ]

  function computeAt(scrollTop: number): string[] {
    return computePinnedFromEntries(tree, scrollTop, H, 4, band)
  }

  it("pins SENT+USER just before RECEIVED reaches the scrollport top", () => {
    expect(computeAt(499)).toEqual([
      "phase-sub",
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
  })

  it("hands off to RECEIVED at the peer boundary (no SENT)", () => {
    expect(computeAt(500)).toEqual(["phase-sub", "call:0", "received:0"])
  })

  it("does not compensate when −rowH would re-admit SENT (flicker)", () => {
    const nextIds = computeAt(500)
    expect(nextIds).toEqual(["phase-sub", "call:0", "received:0"])
    // Prev band was 4 rows; next is 3 → naive delta −34 → scrollTop 466.
    expect(pinBandScrollDelta(4, 3, H)).toBe(-H)
    expect(computeAt(500 - H)).toEqual([
      "phase-sub",
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
    // Stabilizer must refuse that compensation.
    expect(stabilizePinBandScrollTop(500, 4, nextIds, computeAt, H)).toBe(500)
  })

  it("still compensates when the pin set is stable at the new scrollTop", () => {
    // Deep inside RECEIVED body — shortening the band must not flip peers.
    const scrollTop = 700
    const nextIds = computeAt(scrollTop)
    expect(nextIds).toEqual(["phase-sub", "call:0", "received:0"])
    expect(stabilizePinBandScrollTop(scrollTop, 4, nextIds, computeAt, H)).toBe(
      scrollTop - H,
    )
  })

  it("converges: one handoff frame does not oscillate", () => {
    let scrollTop = 499
    let prev = computeAt(scrollTop)
    expect(prev).toContain("sent:0")

    // User scrolls 1px past RECEIVED.
    scrollTop = 500
    const next = computeAt(scrollTop)
    scrollTop = stabilizePinBandScrollTop(scrollTop, prev.length, next, computeAt, H)
    prev = next

    // Same scroll position on the next frame — pins unchanged.
    const again = computeAt(scrollTop)
    expect(again).toEqual(prev)
    expect(stabilizePinBandScrollTop(scrollTop, prev.length, again, computeAt, H)).toBe(
      scrollTop,
    )
    expect(again).toEqual(["phase-sub", "call:0", "received:0"])
    expect(again).not.toContain("sent:0")
  })
})
