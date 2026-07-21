import { describe, expect, it } from "vitest"
import {
  POLISHED_FAILURE_MARKER,
  extractRunRef,
  formatFailureAnswerBody,
  formatRunFailureMessage,
  isUserSafeFailureAnswer,
  stripFailureMarkers,
} from "./failureAnswer.js"

describe("AgentChat failure answers", () => {
  it("detects platform / generic / polished failure prefixes", () => {
    expect(
      isUserSafeFailureAnswer("This request can’t be completed right now. More."),
    ).toBe(true)
    expect(
      isUserSafeFailureAnswer("This request couldn’t be completed. More."),
    ).toBe(true)
    expect(isUserSafeFailureAnswer(`${POLISHED_FAILURE_MARKER}Sorry.`)).toBe(true)
    expect(isUserSafeFailureAnswer("Here is your report.")).toBe(false)
  })

  it("strips the invisible polished marker only", () => {
    expect(stripFailureMarkers(`${POLISHED_FAILURE_MARKER}Hello`)).toBe("Hello")
    expect(stripFailureMarkers("Hello")).toBe("Hello")
  })

  it("extracts run references case-insensitively", () => {
    expect(extractRunRef("See Reference: run_abc-1")).toBe("run_abc-1")
    expect(extractRunRef("include the reference: XYZ.9")).toBe("XYZ.9")
    expect(extractRunRef("no ref here")).toBeNull()
  })

  it("formats failure body without trailing Reference line", () => {
    const answer = `${POLISHED_FAILURE_MARKER}Something went wrong.\n\nReference: run_42`
    expect(formatFailureAnswerBody(answer)).toEqual({
      body: "Something went wrong.",
      ref: "run_42",
    })
  })

  it("rewrites Copilot auth failures for the banner", () => {
    expect(formatRunFailureMessage("Device flow cancelled")).toMatch(/re-authorize/i)
    expect(formatRunFailureMessage("Copilot OAuth token expired")).toMatch(/re-authorize/i)
    expect(formatRunFailureMessage("plain error")).toBe("plain error")
  })
})
