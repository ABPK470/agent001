/**
 * Shared pass: chronological OperationEvent[] → correlated pipelines.
 */

import { isEventType } from "@mia/agent"
import type { DbEvent } from "../../../../infra/persistence/db/events.js"
import { buildPipelinesFromBuckets } from "./build-pipelines.js"
import { buildPreviewToPlanMap, correlateEventsIntoBuckets } from "./correlate.js"
import { filterOperations } from "./filter.js"
import { mergeSyncPlanPipelines } from "./merge-sync-run.js"
import type { ListOperationsOpts, OperationEvent, OperationPipeline } from "./types.js"
import { hydratePersistedSqlEventData } from "../../../../infra/persistence/db/sync-sql-log.js"
import { safeParse } from "./utils.js"

function mapDbEventRow(e: DbEvent): OperationEvent | null {
  if (!isEventType(e.type)) return null
  const data = hydratePersistedSqlEventData(e.type, safeParse(e.data))
  return { type: e.type, timestamp: e.created_at, data }
}

export function mapDbEventsChronological(events: readonly DbEvent[]): OperationEvent[] {
  return [...events].reverse().flatMap<OperationEvent>((e) => {
    const mapped = mapDbEventRow(e)
    return mapped ? [mapped] : []
  })
}

/** Map event_log rows already in ascending created_at order (plan/run audit queries). */
export function mapDbEventsAsc(events: readonly DbEvent[]): OperationEvent[] {
  return events.flatMap<OperationEvent>((e) => {
    const mapped = mapDbEventRow(e)
    return mapped ? [mapped] : []
  })
}

export function buildOperationsFromEvents(
  chrono: readonly OperationEvent[],
  opts: ListOperationsOpts = {}
): OperationPipeline[] {
  const previewToPlan = buildPreviewToPlanMap(chrono)
  const buckets = correlateEventsIntoBuckets(chrono, previewToPlan)
  const built = filterOperations(buildPipelinesFromBuckets(buckets.values()), opts)
  return mergeSyncPlanPipelines(built)
}
