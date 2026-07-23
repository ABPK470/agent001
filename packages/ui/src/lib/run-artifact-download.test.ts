import { describe, expect, it } from "vitest"
import { runArtifactDownloadPath } from "./run-artifact-download"

describe("runArtifactDownloadPath", () => {
  it("encodes nested sandbox paths for the artifacts route", () => {
    expect(runArtifactDownloadPath("run-1", "tmp/BLUEPRINT.md")).toBe(
      "/api/runs/run-1/artifacts/tmp/BLUEPRINT.md",
    )
    expect(runArtifactDownloadPath("run-1", "docs/a b.md")).toBe(
      "/api/runs/run-1/artifacts/docs/a%20b.md",
    )
  })
})
