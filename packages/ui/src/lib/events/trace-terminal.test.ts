import { describe, expect, it } from "vitest"
import { isCancelRaceFailureError, settleTraceOnCancel } from "./trace-terminal"

describe("trace-terminal", () => {
  it("appends user-input-response when ask_user was open", () => {
    const next = settleTraceOnCancel([
      { kind: "user-input-request", question: "Which env?" },
    ])
    expect(next).toHaveLength(2)
    expect(next[1]).toEqual({ kind: "user-input-response", text: "Run cancelled by user" })
  })

  it("leaves trace unchanged when already answered", () => {
    const trace = [
      { kind: "user-input-request", question: "Which env?" },
      { kind: "user-input-response", text: "prod" },
    ]
    expect(settleTraceOnCancel(trace)).toBe(trace)
  })

  it("detects cancel-race tool failures", () => {
    expect(isCancelRaceFailureError('Tool "ask_user" cancelled')).toBe(true)
    expect(isCancelRaceFailureError("Server restarted — run interrupted")).toBe(false)
  })
})
