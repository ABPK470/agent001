import { describe, expect, it } from "vitest"

import { OperationKind } from "../client/index"
import type { OperationPipeline } from "../client/index"
import { pipelineActivityKey, syncPlanIdFromPipeline } from "./OperationLog"

function syncPipeline(over: Partial<OperationPipeline> & Pick<OperationPipeline, "id" | "kind">): OperationPipeline {
  return {
    title: "Test",
    status: "success",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    durationMs: 60_000,
    activityCount: 0,
    eventCount: 0,
    activities: [],
    ...over,
  }
}

describe("OperationLog helpers", () => {
  it("builds activity expansion keys scoped to pipeline id", () => {
    const previewKey = pipelineActivityKey("plan-1:preview", "decision:abc:0")
    const executeKey = pipelineActivityKey("plan-1:execute", "decision:abc:0")
    expect(previewKey).not.toBe(executeKey)
  })

  it("resolves sync plan id from kind-scoped pipeline id", () => {
    const preview = syncPipeline({
      id: "abc-plan:preview",
      planId: "abc-plan",
      kind: OperationKind.SyncPreview,
    })
    const execute = syncPipeline({
      id: "abc-plan:execute",
      kind: OperationKind.SyncExecute,
    })
    expect(syncPlanIdFromPipeline(preview)).toBe("abc-plan")
    expect(syncPlanIdFromPipeline(execute)).toBe("abc-plan")
  })

  it("preview and execute pipelines for the same plan have distinct row ids", () => {
    const preview = syncPipeline({ id: "shared:preview", planId: "shared", kind: OperationKind.SyncPreview })
    const execute = syncPipeline({ id: "shared:execute", planId: "shared", kind: OperationKind.SyncExecute })
    expect(preview.id).not.toBe(execute.id)
  })
})
