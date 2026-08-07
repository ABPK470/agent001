import { describe, expect, it } from "vitest"
import type { OperationPipeline } from "../client/index"
import { flattenOperationRows } from "./operation-flat-rows"
import { resolvePinnedOperationDay } from "./operation-day-pin"

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

const rows = flattenOperationRows(
  [
    pipeline("a", "2026-08-07T10:00:00.000Z"),
    pipeline("b", "2026-08-07T11:00:00.000Z"),
    pipeline("c", "2026-08-06T10:00:00.000Z"),
  ],
  new Set(),
  (iso) => (iso.startsWith("2026-08-07") ? "Today" : "Yesterday"),
)

describe("resolvePinnedOperationDay", () => {
  it("stays clear when the day header is flush at the top", () => {
    expect(
      resolvePinnedOperationDay(rows, { index: 0, offsetInItem: 0 }),
    ).toBeNull()
  })

  it("pins Today once a pipeline under it reaches the fold", () => {
    expect(resolvePinnedOperationDay(rows, { index: 1, offsetInItem: 0 })).toEqual({
      key: "day:Today",
      label: "Today",
      count: 2,
    })
  })

  it("pins Yesterday when that section owns the top row", () => {
    expect(resolvePinnedOperationDay(rows, { index: 4, offsetInItem: 10 })).toEqual({
      key: "day:Yesterday",
      label: "Yesterday",
      count: 1,
    })
  })

  it("pins the day row itself once it has started to scroll away", () => {
    expect(resolvePinnedOperationDay(rows, { index: 3, offsetInItem: 8 })).toEqual({
      key: "day:Yesterday",
      label: "Yesterday",
      count: 1,
    })
  })
})
