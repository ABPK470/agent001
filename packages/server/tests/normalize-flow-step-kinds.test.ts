import { describe, expect, it } from "vitest"

import { parsePresetSteps } from "../src/platform/persistence/db/sync-run-catalog.js"

describe("normalizeFlowStepKinds", () => {
  it("canonicalizes legacy kebab-case step kinds from stored presets", () => {
    const steps = parsePresetSteps(
      JSON.stringify([
        {
          id: "metadata-sync",
          phase: "metadata",
          kind: "metadata-sync",
          title: "Metadata sync",
          description: "Apply metadata",
        },
      ]),
    )
    expect(steps[0]?.kind).toBe("metadataSync")
  })
})
