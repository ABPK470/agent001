/**
 * Operation log query — groups persisted events into pipeline → activity → event trees.
 *
 * Bucketing rules:
 *   1. Standalone sync (planId, no runId precedence for sync.* prefixes) → sync pipeline
 *   2. runId → agent run pipeline (inline sync events become activities)
 *   3. Otherwise → system bucket per minute
 */

import { isEventType } from "@mia/agent"
import * as db from "../../../../platform/persistence/sqlite.js"
import { buildPipelinesFromBuckets } from "./build-pipelines.js"
import { buildPreviewToPlanMap, correlateEventsIntoBuckets } from "./correlate.js"
import { filterOperations } from "./filter.js"
import type { ListOperationsOpts, OperationEvent, OperationPipeline } from "./types.js"
import { safeParse } from "./utils.js"

export function listOperations(opts: ListOperationsOpts = {}): {
  operations: OperationPipeline[]
  scannedEvents: number
  oldestTimestamp: string | null
} {
  const limit = Math.min(opts.limit ?? 1000, 5000)
  const events = db.listEvents({ limit, before: opts.before })
  if (events.length === 0) {
    return { operations: [], scannedEvents: 0, oldestTimestamp: null }
  }

  const chrono = [...events].reverse().flatMap<OperationEvent>((e) => {
    if (!isEventType(e.type)) return []
    return [{ type: e.type, timestamp: e.created_at, data: safeParse(e.data) }]
  })

  const previewToPlan = buildPreviewToPlanMap(chrono)
  const buckets = correlateEventsIntoBuckets(chrono, previewToPlan)
  const operations = filterOperations(buildPipelinesFromBuckets(buckets.values()), opts)

  return {
    operations,
    scannedEvents: events.length,
    oldestTimestamp: events[events.length - 1]?.created_at ?? null
  }
}
