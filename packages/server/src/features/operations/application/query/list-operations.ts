/**
 * Entry point: load recent events from SQLite, group them, return pipelines.
 * Called by listOperations in index.ts.
 */

import * as db from "../../../../platform/persistence/sqlite.js"
import {
  buildOperationsFromEvents,
  mapDbEventsChronological
} from "./build-operations-from-events.js"
import type { ListOperationsOpts, OperationPipeline } from "./types.js"

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

  const chrono = mapDbEventsChronological(events)
  const operations = buildOperationsFromEvents(chrono, opts)

  return {
    operations,
    scannedEvents: events.length,
    oldestTimestamp: events[events.length - 1]?.created_at ?? null
  }
}
