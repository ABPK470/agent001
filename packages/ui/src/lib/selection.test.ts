import { describe, expect, it } from "vitest"
import { SELECT_ACTIVE, SELECT_IDLE, SELECT_TRACK } from "./selection"
import { TAB_PILL_ACTIVE, TAB_PILL_IDLE, TAB_SEGMENT_TRACK } from "../widgets/entity-registry/chrome"

describe("selection dialect", () => {
  it("entity chrome aliases the global select fills (no accent selection)", () => {
    expect(TAB_PILL_ACTIVE).toBe(SELECT_ACTIVE)
    expect(TAB_PILL_IDLE).toBe(SELECT_IDLE)
    expect(TAB_SEGMENT_TRACK).toBe(SELECT_TRACK)
    expect(SELECT_ACTIVE).toContain("--select-fill")
    expect(SELECT_ACTIVE).not.toContain("accent")
    expect(SELECT_TRACK).not.toContain("border")
    expect(SELECT_TRACK).not.toContain("bg-canvas")
  })
})
