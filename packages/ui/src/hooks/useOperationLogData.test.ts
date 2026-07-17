import { describe, expect, it } from "vitest"

import type { OperationPipeline } from "../client/index"
import { mergeHeadRefresh, mergeOperationPipelines } from "../hooks/useOperationLogData"

function pipeline(id: string, startedAt: string, eventCount = 1): OperationPipeline {
  return {
    id,
    kind: "agent-run",
    title: id,
    status: "success",
    startedAt,
    endedAt: startedAt,
    durationMs: 1000,
    activityCount: 0,
    eventCount,
    activities: [],
  }
}

describe("useOperationLogData merge helpers", () => {
  it("merges pipelines by id keeping the highest eventCount", () => {
    const a = pipeline("run-1", "2026-01-02T00:00:00.000Z", 2)
    const b = pipeline("run-1", "2026-01-02T00:00:00.000Z", 5)
    const merged = mergeOperationPipelines([a], [b])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.eventCount).toBe(5)
  })

  it("keeps older scrolled pages when refreshing the head window", () => {
    const head = [pipeline("run-new", "2026-01-03T00:00:00.000Z")]
    const current = [
      pipeline("run-new", "2026-01-03T00:00:00.000Z", 1),
      pipeline("run-old", "2026-01-01T00:00:00.000Z"),
    ]
    const merged = mergeHeadRefresh(current, head, "2026-01-02T00:00:00.000Z")
    expect(merged.map((p) => p.id)).toEqual(["run-new", "run-old"])
  })
})
