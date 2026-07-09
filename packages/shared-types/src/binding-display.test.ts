import { describe, expect, it } from "vitest"

import { formatHandlerInputPreviewHint } from "./binding-display.js"

describe("formatHandlerInputPreviewHint", () => {
  it("uses builtin preview labels", () => {
    expect(
      formatHandlerInputPreviewHint(
        { name: "ContractName", source: { type: "contractName" } },
        {},
      ),
    ).toContain("Contract name")
  })

  it("marks step-bound slots", () => {
    expect(formatHandlerInputPreviewHint({ name: "datasetId" }, {})).toBe("per flow step")
  })
})
