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

  it("emits open activity children under an open pipeline", () => {
    const run: OperationPipeline = {
      ...pipeline("run-1", "2026-01-01T10:00:00.000Z"),
      activities: [
        {
          id: "phase:preview",
          name: "Preview",
          status: "success",
          startedAt: "2026-01-01T10:00:00.000Z",
          endedAt: "2026-01-01T10:00:01.000Z",
          durationMs: 1000,
          events: [],
          children: [
            {
              id: "preflight",
              name: "Preflight checks",
              status: "success",
              startedAt: "2026-01-01T10:00:00.000Z",
              endedAt: "2026-01-01T10:00:01.000Z",
              durationMs: 400,
              events: [],
            },
          ],
        },
      ],
    }
    const rows = flattenOperationRows([run], new Set(), () => "Today", {
      openPipelineIds: new Set(["run-1"]),
      openActivityKeys: new Set(["run-1|phase:preview"]),
      activityKeyOf: (pipelineId, activityId, parentKey) =>
        parentKey ? `${parentKey}/${activityId}` : `${pipelineId}|${activityId}`,
    })
    expect(rows.map((r) => r.type)).toEqual(["day", "pipeline", "activity", "activity"])
    expect(rows.filter((r) => r.type === "activity").map((r) => r.activityKey)).toEqual([
      "run-1|phase:preview",
      "run-1|phase:preview/preflight",
    ])
  })
})
