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
  it("points at browser Downloads for a single file", () => {
    expect(
      formatWorkspaceSaveMessage({
        count: 1,
        bytes: 100,
        mode: "downloads",
        folderName: "report.html",
      }),
    ).toBe("Downloaded 1 file (report.html) — check your browser Downloads")
  })

  it("points at browser Downloads for a multi-file zip", () => {
    expect(
      formatWorkspaceSaveMessage({
        count: 4,
        bytes: 100,
        mode: "downloads",
        folderName: "mia-run-abc.zip",
      }),
    ).toBe("Downloaded 4 files as a zip (mia-run-abc.zip) — check your browser Downloads")
  })

  it("handles empty path lists", () => {
    expect(formatWorkspaceSaveMessage({ count: 0, bytes: 0, mode: "downloads" })).toBe(
      "Nothing to save",
    )
  })
})
