import { describe, expect, it } from "vitest"
import { OperationKind, OperationStatus } from "../../../../internal/enums/operations.js"
import { mergeOperationPipelinePages } from "./list-operations.js"
import type { OperationPipeline } from "./types.js"

function pipe(id: string, eventCount: number, startedAt: string): OperationPipeline {
  return {
    id,
    kind: OperationKind.AgentRun,
    title: id,
    status: OperationStatus.Success,
    startedAt,
    endedAt: startedAt,
    durationMs: 1,
    activityCount: 0,
    eventCount,
    activities: [],
  }
}

describe("mergeOperationPipelinePages", () => {
  it("keeps higher eventCount when the same pipeline appears in two scan windows", () => {
    const a = pipe("run-1", 2, "2026-01-02T00:00:00.000Z")
    const b = pipe("run-1", 9, "2026-01-02T00:00:00.000Z")
    const c = pipe("run-0", 1, "2026-01-01T00:00:00.000Z")
    const merged = mergeOperationPipelinePages([a, c], [b])
    expect(merged.map((p) => p.id)).toEqual(["run-1", "run-0"])
    expect(merged[0]!.eventCount).toBe(9)
  })
})
