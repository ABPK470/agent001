import { describe, expect, it } from "vitest"
import type { OperationPipeline } from "../client/index"
import { flattenOperationRows } from "./operation-flat-rows"

function pipeline(id: string, startedAt: string): OperationPipeline {
  return {
    id,
    kind: "agent-run",
    title: id,
    status: "success",
    startedAt,
    endedAt: startedAt,
    durationMs: 1,
    activityCount: 0,
    eventCount: 1,
    activities: [],
  }
}

describe("flattenOperationRows", () => {
  it("emits day headers and pipelines; skips pipelines when day collapsed", () => {
    const rows = flattenOperationRows(
      [
        pipeline("a", "2026-01-01T10:00:00.000Z"),
        pipeline("b", "2026-01-01T11:00:00.000Z"),
        pipeline("c", "2026-01-02T10:00:00.000Z"),
      ],
      new Set(["Thu, Jan 1"]),
      (iso) =>
        iso.startsWith("2026-01-01") ? "Thu, Jan 1" : "Fri, Jan 2",
    )
    expect(rows.map((r) => r.type)).toEqual(["day", "day", "pipeline"])
    expect(rows.filter((r) => r.type === "pipeline").map((r) => r.key)).toEqual(["c"])
  })
})
