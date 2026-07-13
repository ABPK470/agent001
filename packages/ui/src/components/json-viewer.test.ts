import { describe, expect, it } from "vitest"

import { isSyncDecisionLogDetails } from "./DecisionLogPanel"

describe("isSyncDecisionLogDetails", () => {
  it("detects preflight decision arrays", () => {
    expect(
      isSyncDecisionLogDetails({
        decisions: [{ id: "definition-contract", title: "Published definition selected", summary: "ok" }],
      }),
    ).toBe(true)
  })

  it("rejects non-decision objects", () => {
    expect(isSyncDecisionLogDetails({ foo: "bar" })).toBe(false)
    expect(isSyncDecisionLogDetails({ decisions: [] })).toBe(false)
  })
})
