import { describe, expect, it } from "vitest"

import { createPreviewProgress, isPreviewInProgress, reduceEnvSyncPreviewProgress } from "./preview-progress"

describe("preview-progress", () => {
  it("isPreviewInProgress is true only while running", () => {
    const running = createPreviewProgress({
      entityType: "contract",
      entityId: "1",
      source: "uat",
      target: "dev",
    })
    expect(isPreviewInProgress(true, running)).toBe(true)
    expect(isPreviewInProgress(false, running)).toBe(true)

    const done = reduceEnvSyncPreviewProgress(running, "sync.preview.completed", {
      totals: { insert: 1, update: 0, delete: 0 },
    })!
    expect(isPreviewInProgress(false, done)).toBe(false)
    expect(isPreviewInProgress(false, null)).toBe(false)
  })

  it("tracks table start and done from SSE", () => {
    let progress = createPreviewProgress({
      entityType: "contract",
      entityId: "42",
      source: "uat",
      target: "dev",
    })
    progress = reduceEnvSyncPreviewProgress(progress, "sync.preview.table.start", {
      table: "core.Contract",
      tableIndex: 1,
      tableTotal: 3,
    })!
    progress = reduceEnvSyncPreviewProgress(progress, "sync.preview.table.done", {
      table: "core.Contract",
      insert: 1,
      update: 0,
      delete: 0,
    })!
    expect(progress.tables["core.Contract"]?.status).toBe("done")
    expect(progress.message).toContain("+1")
  })
})
