import { describe, expect, it } from "vitest"
import {
  CONTROL_IDLE,
  LIST_ROW_ACTIVE,
  SELECT_ACTIVE,
  SELECT_IDLE,
  SELECT_TRACK,
} from "./selection"
import { TAB_PILL_ACTIVE, TAB_PILL_IDLE, TAB_SEGMENT_TRACK } from "../widgets/entity-registry/chrome"

describe("selection dialect", () => {
  it("entity chrome aliases the global select dialect (ink/paper, no accent selection)", () => {
    expect(TAB_PILL_ACTIVE).toBe(SELECT_ACTIVE)
    expect(TAB_PILL_IDLE).toBe(SELECT_IDLE)
    expect(TAB_SEGMENT_TRACK).toBe(SELECT_TRACK)
    expect(SELECT_ACTIVE).toContain("bg-text")
    expect(SELECT_ACTIVE).not.toContain("bg-accent")
    expect(SELECT_ACTIVE).not.toContain("text-accent")
    expect(SELECT_TRACK).toContain("border")
    expect(SELECT_TRACK).not.toContain("bg-canvas")
  })

  it("list rows use a left rule, not a second perimeter frame", () => {
    expect(LIST_ROW_ACTIVE).toContain("before:bg-text")
    expect(LIST_ROW_ACTIVE).not.toContain("border-border-strong")
  })

  it("controls strengthen the border on hover — no fill washes", () => {
    expect(CONTROL_IDLE).toContain("hover:border-border-strong")
    expect(CONTROL_IDLE).not.toContain("hover-fill")
    expect(CONTROL_IDLE).not.toContain("overlay")
  })
})
