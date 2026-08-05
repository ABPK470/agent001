import { describe, expect, it } from "vitest"
import {
  shouldAutoOpenWorkChip,
  stepChipAutoOpen,
  workChipOpen,
} from "./workChipFold"

describe("workChipFold", () => {
  it("keeps only the latest work open until narrative lands", () => {
    expect(shouldAutoOpenWorkChip(true, false)).toBe(true)
    expect(shouldAutoOpenWorkChip(true, true)).toBe(false)
    expect(shouldAutoOpenWorkChip(false, false)).toBe(false)
    expect(shouldAutoOpenWorkChip(false, true)).toBe(false)
  })

  it("derives step auto-open from running / keepOpen", () => {
    expect(stepChipAutoOpen(true, false, "done")).toBe(true)
    expect(stepChipAutoOpen(false, true, "done")).toBe(true)
    expect(stepChipAutoOpen(false, false, "running")).toBe(true)
    expect(stepChipAutoOpen(false, false, "done")).toBe(false)
  })

  it("lets user override win without an effect round-trip", () => {
    expect(workChipOpen(false, false, true)).toBe(true)
    expect(workChipOpen(false, true, false)).toBe(false)
    expect(workChipOpen(true, false, true)).toBe(false)
    expect(workChipOpen(true, true, false)).toBe(true)
  })
})
