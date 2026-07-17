import { describe, expect, it } from "vitest"

import {
  assertFlowStepCatalogIds,
  FlowStepsValidationError,
  parseStoredFlowStepsJson,
} from "../src/infra/persistence/sync-flow-steps.js"
import { parsePresetSteps } from "../src/infra/persistence/db/sync-run-catalog.js"

describe("flow step catalog ids", () => {
  it("accepts canonical camelCase step kinds", () => {
    const steps = parseStoredFlowStepsJson(
      JSON.stringify([
        {
          id: "metadataSync",
          kind: "metadataSync",
          title: "Metadata sync",
          description: "Apply metadata",
        },
      ]),
    )
    expect(steps[0]?.kind).toBe("metadataSync")
  })

  it("rejects legacy kebab-case step kinds at read time", () => {
    expect(() =>
      parsePresetSteps(
        JSON.stringify([
          {
            id: "metadata-sync",
            phase: "metadata",
            kind: "metadata-sync",
            title: "Metadata sync",
            description: "Apply metadata",
          },
        ]),
      ),
    ).toThrow(FlowStepsValidationError)
  })

  it("assertFlowStepCatalogIds names the offending field", () => {
    expect(() =>
      assertFlowStepCatalogIds([
        {
          id: "metadataSync",
          kind: "metadata-sync",
          title: "Metadata sync",
          description: "Apply metadata",
        },
      ]),
    ).toThrow(/Kind id/)
  })
})
