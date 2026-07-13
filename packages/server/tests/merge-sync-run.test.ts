import { EventType, OperationKind, OperationStatus } from "@mia/shared-enums"
import { describe, expect, it } from "vitest"
import { mergeSyncPlanPipelines } from "../src/features/operations/application/query/merge-sync-run.js"
import type { OperationPipeline } from "../src/features/operations/application/query/types.js"

function stubPipeline(
  planId: string,
  kind: typeof OperationKind.SyncPreview | typeof OperationKind.SyncExecute,
  status: OperationStatus = OperationStatus.Success
): OperationPipeline {
  const phase = kind === OperationKind.SyncExecute ? "execute" : "preview"
  return {
    id: `${planId}:${phase}`,
    planId,
    kind,
    title: `${kind === OperationKind.SyncExecute ? "Execute" : "Preview"} Entity — Demo`,
    status,
    startedAt: "2026-07-12T10:00:00.000Z",
    endedAt: "2026-07-12T10:01:00.000Z",
    durationMs: 60_000,
    activityCount: 1,
    eventCount: 2,
    activities: [
      {
        id: `${phase}-started`,
        name: "started",
        status: OperationStatus.Success,
        startedAt: "2026-07-12T10:00:00.000Z",
        endedAt: "2026-07-12T10:00:00.000Z",
        durationMs: 0,
        events: []
      }
    ]
  }
}

describe("mergeSyncPlanPipelines", () => {
  it("merges preview and execute rows for the same plan", () => {
    const merged = mergeSyncPlanPipelines([
      stubPipeline("plan-1", OperationKind.SyncExecute),
      stubPipeline("plan-1", OperationKind.SyncPreview),
      {
        id: "run-1",
        kind: OperationKind.AgentRun,
        title: "agent goal",
        status: OperationStatus.Success,
        startedAt: "2026-07-12T09:00:00.000Z",
        endedAt: "2026-07-12T09:05:00.000Z",
        durationMs: 300_000,
        activityCount: 1,
        eventCount: 1,
        activities: []
      }
    ])

    expect(merged).toHaveLength(2)
    const syncRun = merged.find((op) => op.kind === OperationKind.SyncRun)
    expect(syncRun?.id).toBe("plan-1")
    expect(syncRun?.activities.map((a) => a.name)).toEqual(["Preview", "Execute"])
    expect(syncRun?.eventCount).toBe(4)
  })

  it("keeps preview-only plans as sync-run with one phase", () => {
    const merged = mergeSyncPlanPipelines([stubPipeline("plan-preview-only", OperationKind.SyncPreview)])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.kind).toBe(OperationKind.SyncRun)
    expect(merged[0]?.activities).toHaveLength(1)
    expect(merged[0]?.activities[0]?.name).toBe("Preview")
  })
})
