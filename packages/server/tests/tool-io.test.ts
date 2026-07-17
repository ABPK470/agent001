import { EventType } from "@mia/shared-enums"
import { describe, expect, it } from "vitest"
import {
  buildToolIoFromStepEvents,
  buildToolIoSummary
} from "../src/api/operations/application/query/tool-io.js"
import type { OperationEvent } from "../src/api/operations/application/query/types.js"

describe("tool-io", () => {
  it("builds structured tool I/O from step events", () => {
    const events: OperationEvent[] = [
      {
        type: EventType.StepStarted,
        timestamp: "2026-07-12T10:00:00.000Z",
        data: {
          stepId: "step-1",
          action: "search_catalog",
          input: { search: "Customer" }
        }
      },
      {
        type: EventType.StepCompleted,
        timestamp: "2026-07-12T10:00:02.000Z",
        data: {
          stepId: "step-1",
          action: "search_catalog",
          durationMs: 2000,
          output: { result: "Found 3 entities" }
        }
      }
    ]

    const io = buildToolIoFromStepEvents(events)
    expect(io?.tool).toBe("search_catalog")
    expect(io?.status).toBe("success")
    expect(io?.argsSummary).toContain("search=")
    expect(io?.outputText).toBe("Found 3 entities")
    expect(buildToolIoSummary(io!)).toContain("Found 3 entities")
  })
})
