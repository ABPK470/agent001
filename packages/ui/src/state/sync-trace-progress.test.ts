import { describe, expect, it } from "vitest"
import {
  createSyncProgressState,
  finalizeSyncProgress,
  reduceSyncSseEvent,
  syncProgressResultLine,
  syncProgressToTraceEntry,
} from "./sync-trace-progress.js"

describe("sync-trace-progress", () => {
  it("coalesces table progress into headline and detail", () => {
    let state = createSyncProgressState("step-1", "sync_diff_scan")
    state = reduceSyncSseEvent(state, "sync.scan.discovered", {
      totalOnSource: 523,
      toScan: 523,
      sampled: false,
      entityType: "pipelineActivity",
      source: "uat",
      target: "dev"
    })
    state = reduceSyncSseEvent(state, "sync.scan.entity.start", {
      entityIndex: 2,
      entityTotal: 523,
      entityType: "pipelineActivity",
      entityId: 123,
      entityLabel: "Trial balance export",
      source: "uat",
      target: "dev"
    })
    state = reduceSyncSseEvent(state, "sync.preview.table.start", {
      table: "core.Pipeline",
      tableIndex: 2,
      tableTotal: 12,
      predicate: "pipelineId = 123"
    })
    const entry = syncProgressToTraceEntry(state)
    expect(entry.kind).toBe("sync-progress")
    if (entry.kind !== "sync-progress") return
    expect(entry.headline).toContain("id 123")
    expect(entry.headline).toContain("Trial balance export")
    expect(entry.headline).toContain("(2/523)")
    expect(entry.detail).toContain("Pipeline (2/12)")
    expect(entry.lastTable?.name).toBe("core.Pipeline")
  })

  it("captures latest SQL preview for trace display", () => {
    let state = createSyncProgressState("step-2", "sync_preview")
    state = reduceSyncSseEvent(state, "sync.preview.sql", {
      label: "fetchPkHash(core.Pipeline)",
      connection: "DEV",
      sql: "SELECT pk, HASHBYTES(...) FROM core.Pipeline WHERE pipelineId = 123",
      rowCount: 42,
      durationMs: 880
    })
    const entry = syncProgressToTraceEntry(state)
    if (entry.kind !== "sync-progress") throw new Error("expected sync-progress")
    expect(entry.sql?.preview).toContain("HASHBYTES")
    expect(entry.detail).toContain("42 rows")
  })

  it("finalize keeps SSE summary on success (does not dump full tool text)", () => {
    let state = createSyncProgressState("step-3", "sync_preview")
    state = reduceSyncSseEvent(state, "sync.preview.completed", {
      planId: "abcdefgh-1234",
      totals: { insert: 3, update: 1, delete: 0 },
    })
    const finalized = finalizeSyncProgress(state, "Plan abcdefgh…\n  huge dump…", false)
    expect(finalized.result).toContain("Preview complete — plan abcdefgh")
    expect(finalized.result).not.toContain("huge dump")
  })

  it("hides stub result lines like ok/done", () => {
    expect(syncProgressResultLine("ok", "done")).toBeNull()
    expect(syncProgressResultLine("done", "done")).toBeNull()
    expect(syncProgressResultLine("Preview complete — plan abc", "done")).toBe(
      "Preview complete — plan abc",
    )
    expect(syncProgressResultLine("ok", "error")).toBe("ok")
  })
})
