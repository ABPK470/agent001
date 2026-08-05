import { describe, expect, it } from "vitest"
import {
  shouldShowStepCheckInChat,
  stepBlockHeaderChrome,
} from "./stepOutcomeChrome"

describe("stepOutcomeChrome", () => {
  it("uses muted auto-repaired tag — not a loud badge", () => {
    expect(
      stepBlockHeaderChrome({
        outcome: "repaired",
        isRetrying: false,
        isFailed: false,
      }),
    ).toEqual({ kind: "muted", text: "(auto-repaired)" })
    expect(
      stepBlockHeaderChrome({
        outcome: "repaired",
        detail: "1.6s",
        isRetrying: false,
        isFailed: false,
      }),
    ).toEqual({ kind: "muted", text: "· 1.6s (auto-repaired)" })
  })

  it("keeps Failed chrome only for unrepaired failure", () => {
    expect(
      stepBlockHeaderChrome({
        outcome: "failed",
        detail: "missing tokens",
        isRetrying: false,
        isFailed: true,
      }),
    ).toEqual({ kind: "failed", detail: "missing tokens" })
  })

  it("hides nested check once the step is repaired or cleanly passed", () => {
    expect(shouldShowStepCheckInChat("repaired")).toBe(false)
    expect(shouldShowStepCheckInChat("passed")).toBe(false)
    expect(shouldShowStepCheckInChat("failed")).toBe(true)
    expect(shouldShowStepCheckInChat("running")).toBe(true)
  })
})
