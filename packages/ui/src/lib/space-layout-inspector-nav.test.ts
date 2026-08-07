import { describe, expect, it } from "vitest"
import {
  spaceLayoutInspectorEligible,
  tileHotkeyIndex,
} from "./space-layout-inspector-nav"

describe("spaceLayoutInspectorEligible", () => {
  it("requires at least two tiles", () => {
    expect(spaceLayoutInspectorEligible(0)).toBe(false)
    expect(spaceLayoutInspectorEligible(1)).toBe(false)
    expect(spaceLayoutInspectorEligible(2)).toBe(true)
    expect(spaceLayoutInspectorEligible(5)).toBe(true)
  })
})

describe("tileHotkeyIndex", () => {
  it("maps 1–n to zero-based indices", () => {
    expect(tileHotkeyIndex("1", 3)).toBe(0)
    expect(tileHotkeyIndex("2", 3)).toBe(1)
    expect(tileHotkeyIndex("3", 3)).toBe(2)
  })

  it("rejects out-of-range digits", () => {
    expect(tileHotkeyIndex("4", 3)).toBe(null)
    expect(tileHotkeyIndex("0", 3)).toBe(null)
    expect(tileHotkeyIndex("9", 2)).toBe(null)
  })

  it("rejects non-digit keys", () => {
    expect(tileHotkeyIndex("Enter", 3)).toBe(null)
    expect(tileHotkeyIndex("", 3)).toBe(null)
  })

  it("rejects empty leaf lists", () => {
    expect(tileHotkeyIndex("1", 0)).toBe(null)
  })
})
