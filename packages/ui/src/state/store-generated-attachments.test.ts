/**
 * Store SSE handling for agent-generated deliverable attachments.
 *
 * `attachment.promoted` should surface a download chip under the run that
 * produced the file (live, mid-run). `run.queued` clears the new run's
 * chips so a fresh run starts clean. Duplicate promotes are deduped.
 */

import { beforeEach, describe, expect, it } from "vitest"
import { useStore } from "./store"

function resetState(): void {
  useStore.setState({
    generatedAttachmentsByRun: {},
    runs: [],
    trace: [],
    sseEventLog: [],
    pendingInput: null,
  })
}

describe("store generated-attachment events", () => {
  beforeEach(() => {
    resetState()
  })

  it("attachment.promoted adds a download chip under the producing run", () => {
    const { handleEvent } = useStore.getState()
    handleEvent({
      type: "attachment.promoted",
      timestamp: new Date().toISOString(),
      data: {
        id: "att-1",
        runId: "run-1",
        normalizedName: "uat_top5.csv",
        sizeBytes: 9_200_000,
        mediaType: "text/csv",
        source: "generated",
        scope: "workspace_asset"
      }
    })
    const state = useStore.getState()
    expect(state.generatedAttachmentsByRun["run-1"]).toHaveLength(1)
    expect(state.generatedAttachmentsByRun["run-1"][0]).toMatchObject({
      id: "att-1",
      name: "uat_top5.csv",
      sizeBytes: 9_200_000
    })
  })

  it("dedupes repeated promotes for the same attachment id", () => {
    const { handleEvent } = useStore.getState()
    const evt = {
      type: "attachment.promoted",
      timestamp: new Date().toISOString(),
      data: {
        id: "att-1",
        runId: "run-1",
        normalizedName: "uat_top5.csv",
        sizeBytes: 9_200_000,
        mediaType: "text/csv",
        source: "generated",
        scope: "workspace_asset"
      }
    } as const
    handleEvent(evt)
    handleEvent(evt)
    expect(useStore.getState().generatedAttachmentsByRun["run-1"]).toHaveLength(1)
  })

  it("ignores attachment.promoted with no runId (cannot attribute to a run)", () => {
    const { handleEvent } = useStore.getState()
    handleEvent({
      type: "attachment.promoted",
      timestamp: new Date().toISOString(),
      data: { id: "att-2", runId: null, normalizedName: "x.csv", sizeBytes: 1, mediaType: "text/csv" }
    })
    expect(useStore.getState().generatedAttachmentsByRun).toEqual({})
  })

  it("run.queued clears the new run's generated attachments", () => {
    const { handleEvent } = useStore.getState()
    handleEvent({
      type: "attachment.promoted",
      timestamp: new Date().toISOString(),
      data: {
        id: "att-1",
        runId: "run-1",
        normalizedName: "uat_top5.csv",
        sizeBytes: 9_200_000,
        mediaType: "text/csv",
        source: "generated",
        scope: "workspace_asset"
      }
    })
    expect(useStore.getState().generatedAttachmentsByRun["run-1"]).toHaveLength(1)
    handleEvent({
      type: "run.queued",
      timestamp: new Date().toISOString(),
      data: { runId: "run-1", goal: "redo" }
    })
    expect(useStore.getState().generatedAttachmentsByRun["run-1"]).toBeUndefined()
  })
})
