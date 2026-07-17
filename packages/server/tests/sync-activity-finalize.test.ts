import { OperationStatus } from "@mia/shared-enums"
import { describe, expect, it } from "vitest"
import { finalizeStaleRunningActivities } from "../src/api/operations/application/query/utils.js"
import type { OperationActivity } from "../src/api/operations/application/query/types.js"

describe("finalizeStaleRunningActivities", () => {
  it("marks orphan running table activities skipped when sync run ended skipped", () => {
    const activities: OperationActivity[] = [
      {
        id: "tbl:core.DatasetMapping:1",
        name: "core.DatasetMapping",
        status: OperationStatus.Running,
        startedAt: "2026-07-12T10:00:00.000Z",
        endedAt: null,
        durationMs: null,
        events: []
      }
    ]
    finalizeStaleRunningActivities(
      activities,
      "2026-07-12T10:00:05.000Z",
      OperationStatus.Skipped,
      "Skipped"
    )
    expect(activities[0]?.status).toBe(OperationStatus.Skipped)
    expect(activities[0]?.summary).toBe("Skipped")
  })
})
