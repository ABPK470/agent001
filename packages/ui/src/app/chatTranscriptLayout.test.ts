import { describe, expect, it } from "vitest"

import { COMPACT_TABLE_WRAPPER_CLASS } from "../components/SmartAnswer"
import {
  FORBIDDEN_HOME_TRANSCRIPT_SCROLL_MASK_CLASSES,
  HOME_TRANSCRIPT_SCROLL_CLASS,
  homeTranscriptScrollClassName,
} from "./chatTranscriptLayout"

describe("chatTranscriptLayout", () => {
  it("home transcript scroll does not use mask-image fade classes", () => {
    const scrollClass = homeTranscriptScrollClassName()
    for (const forbidden of FORBIDDEN_HOME_TRANSCRIPT_SCROLL_MASK_CLASSES) {
      expect(scrollClass).not.toContain(forbidden)
    }
    expect(scrollClass).toBe(HOME_TRANSCRIPT_SCROLL_CLASS)
    expect(scrollClass).toContain("overflow-x-auto")
  })

  it("compact markdown tables use inset border shell (not ring)", () => {
    expect(COMPACT_TABLE_WRAPPER_CLASS).toContain("border")
    expect(COMPACT_TABLE_WRAPPER_CLASS).not.toMatch(/\bring-/)
  })
})
