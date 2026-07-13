/**
 * Shared pass: chronological OperationEvent[] → correlated pipelines.
 */

import { isEventType } from "@mia/agent"
import type { DbEvent } from "../../../../platform/persistence/db/events.js"
import { buildPipelinesFromBuckets } from "./build-pipelines.js"
import { buildPreviewToPlanMap, correlateEventsIntoBuckets } from "./correlate.js"
import { filterOperations } from "./filter.js"
import type { ListOperationsOpts, OperationEvent, OperationPipeline } from "./types.js"
import { safeParse } from "./utils.js"

export function mapDbEventsChronological(events: readonly DbEvent[]): OperationEvent[] {
  return [...events].reverse().flatMap<OperationEvent>((e) => {
    if (!isEventType(e.type)) return []
    return [{ type: e.type, timestamp: e.created_at, data: safeParse(e.data) }]
  })
}

/** Map event_log rows already in ascending created_at order (plan/run audit queries). */
export function mapDbEventsAsc(events: readonly DbEvent[]): OperationEvent[] {
  return events.flatMap<OperationEvent>((e) => {
    if (!isEventType(e.type)) return []
    return [{ type: e.type, timestamp: e.created_at, data: safeParse(e.data) }]
  })
}

export function buildOperationsFromEvents(
  chrono: readonly OperationEvent[],
  opts: ListOperationsOpts = {}
): OperationPipeline[] {
  const previewToPlan = buildPreviewToPlanMap(chrono)
  const buckets = correlateEventsIntoBuckets(chrono, previewToPlan)
  return filterOperations(buildPipelinesFromBuckets(buckets.values()), opts)
}
