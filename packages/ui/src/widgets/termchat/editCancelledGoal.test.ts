import { describe, expect, it } from "vitest"
import { RunStatus } from "../../enums"
import { canOfferEditCancelledGoal, isCancelTerminalRun } from "./editCancelledGoal"

describe("isCancelTerminalRun", () => {
  it("treats Cancelled as terminal", () => {
    expect(isCancelTerminalRun({
      status: RunStatus.Cancelled,
      supersededByResume: false,
    })).toBe(true)
  })

  it("treats cancel-race failure as terminal", () => {
    expect(isCancelTerminalRun({
      status: RunStatus.Failed,
      error: "Run cancelled by user",
      supersededByResume: false,
    })).toBe(true)
  })

  it("ignores resume-superseded cancels", () => {
    expect(isCancelTerminalRun({
      status: RunStatus.Cancelled,
      supersededByResume: true,
    })).toBe(false)
  })

  it("ignores ordinary failures", () => {
    expect(isCancelTerminalRun({
      status: RunStatus.Failed,
      error: "tool blew up",
      supersededByResume: false,
    })).toBe(false)
  })
})

describe("canOfferEditCancelledGoal", () => {
  it("offers edit only for own cancelled idle turns", () => {
    expect(canOfferEditCancelledGoal({
      isOwnGoal: true,
      readOnly: false,
      threadBusy: false,
      isCancelTerminal: true,
    })).toBe(true)
  })

  it("hides edit when read-only, busy, foreign, or not cancelled", () => {
    const base = {
      isOwnGoal: true,
      readOnly: false,
      threadBusy: false,
      isCancelTerminal: true,
    }
    expect(canOfferEditCancelledGoal({ ...base, readOnly: true })).toBe(false)
    expect(canOfferEditCancelledGoal({ ...base, threadBusy: true })).toBe(false)
    expect(canOfferEditCancelledGoal({ ...base, isOwnGoal: false })).toBe(false)
    expect(canOfferEditCancelledGoal({ ...base, isCancelTerminal: false })).toBe(false)
  })
})
