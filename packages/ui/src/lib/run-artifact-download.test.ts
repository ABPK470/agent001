import { describe, expect, it } from "vitest"
import {
  formatWorkspaceSaveMessage,
  runArtifactDownloadPath,
} from "./run-artifact-download"

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

describe("formatWorkspaceSaveMessage", () => {
  it("names the chosen folder when the picker path succeeded", () => {
    expect(
      formatWorkspaceSaveMessage({
        count: 4,
        bytes: 100,
        mode: "folder",
        folderName: "Desktop",
      }),
    ).toBe('Saved 4 files to “Desktop”')
  })

  it("admits Downloads fallback when the picker is unavailable", () => {
    expect(
      formatWorkspaceSaveMessage({
        count: 4,
        bytes: 100,
        mode: "downloads",
      }),
    ).toBe("Saved 4 files to your Downloads folder")
  })
})
