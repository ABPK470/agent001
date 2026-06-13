import { OperationKind, OperationStatus } from "../../../../../shared/enums/operations.js"
import type { OperationEvent, OperationPipeline } from "../types.js"
import { durationOf } from "../utils.js"

export function buildSystemPipeline(key: string, events: OperationEvent[]): OperationPipeline {
  const startedAt = events[0].timestamp
  const endedAt = events[events.length - 1].timestamp
  const minute = key.slice(7)

  return {
    id: key,
    kind: OperationKind.System,
    title: `System events — ${minute.replace("T", " ")}`,
    status: OperationStatus.Success,
    startedAt,
    endedAt,
    durationMs: durationOf(startedAt, endedAt),
    activityCount: 1,
    eventCount: events.length,
    activities: [
      {
        id: "events",
        name: "events",
        status: OperationStatus.Success,
        startedAt,
        endedAt,
        durationMs: durationOf(startedAt, endedAt),
        events
      }
    ]
  }
}
