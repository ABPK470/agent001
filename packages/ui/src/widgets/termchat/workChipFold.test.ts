import { describe, expect, it } from "vitest"
import { shouldAutoOpenWorkChip } from "./workChipFold"

describe("shouldAutoOpenWorkChip", () => {
  it("keeps only the latest work open until narrative lands", () => {
    expect(shouldAutoOpenWorkChip(true, false)).toBe(true)
    expect(shouldAutoOpenWorkChip(true, true)).toBe(false)
    expect(shouldAutoOpenWorkChip(false, false)).toBe(false)
    expect(shouldAutoOpenWorkChip(false, true)).toBe(false)
  })
})
