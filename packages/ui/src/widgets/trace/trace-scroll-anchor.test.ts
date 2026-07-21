import { describe, expect, it } from "vitest"
import { scrollDeltaToDesiredTop } from "./trace-scroll-anchor"

describe("scrollDeltaToDesiredTop", () => {
  it("is zero when already at the desired viewport Y", () => {
    expect(scrollDeltaToDesiredTop(100, 100)).toBe(0)
  })

  it("scrolls up when the anchor sits below the target (post-collapse jump down)", () => {
    // Anchor painted at 800, we want it at 100 (under pins) → scrollTop += 700
    expect(scrollDeltaToDesiredTop(800, 100)).toBe(700)
  })

  it("scrolls down when the anchor sits above the target", () => {
    expect(scrollDeltaToDesiredTop(40, 120)).toBe(-80)
  })
})
