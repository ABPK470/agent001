import { describe, expect, it } from "vitest"
import {
  computeThreadRailFits,
  leftGutterPx,
} from "./threadRailLayout"

describe("computeThreadRailFits", () => {
  it("fits when gutter clears the rail footprint", () => {
    expect(computeThreadRailFits(1640)).toBe(true)
    expect(computeThreadRailFits(1619)).toBe(true)
    expect(computeThreadRailFits(1800)).toBe(true)
  })

  it("does not fit when left gutter is narrower than the rail", () => {
    expect(computeThreadRailFits(1463)).toBe(false)
    expect(computeThreadRailFits(1400)).toBe(false)
    expect(computeThreadRailFits(1060)).toBe(false)
  })

  it("never fits below lg overlay breakpoint", () => {
    expect(computeThreadRailFits(1023)).toBe(false)
  })

  it("matches chat column gutter math", () => {
    expect(leftGutterPx(1620)).toBeCloseTo(330, 0)
    expect(leftGutterPx(1060)).toBeCloseTo(50, 0)
  })
})
