/**
 * Entry point: load events from SQLite event_log, group into pipelines.
 * Single code path for list + focus (plan/run audit).
 */

import * as db from "../../../../platform/persistence/sqlite.js"
import {
  buildOperationsFromEvents,
  mapDbEventsChronological
} from "./build-operations-from-events.js"
import { excludeSystemPipelines, filterOperations } from "./filter.js"
import { listOperationsForPlan } from "./list-operations-for-plan.js"
import { listOperationsForRun } from "./list-operations-for-run.js"
import type { ListOperationsOpts, ListOperationsResult } from "./types.js"

/** Events read per page when scanning event_log (newest first, cursor via `before`). */
export const OPERATIONS_PAGE_EVENT_LIMIT = 5000

export function listOperations(opts: ListOperationsOpts = {}): ListOperationsResult {
  if (opts.planId) {
    const { operation, scannedEvents } = listOperationsForPlan(opts.planId)
    return {
      operations: operation ? [operation] : [],
      scannedEvents,
      oldestTimestamp: null,
      hasMore: false,
      mode: "focus"
    }
  }

  if (opts.runId) {
    const { operation, scannedEvents } = listOperationsForRun(opts.runId)
    return {
      operations: operation ? [operation] : [],
      scannedEvents,
      oldestTimestamp: null,
      hasMore: false,
      mode: "focus"
    }
  }

  const limit = Math.min(opts.limit ?? OPERATIONS_PAGE_EVENT_LIMIT, 10_000)
  const events = db.listEvents({ limit, before: opts.before })
  if (events.length === 0) {
    return {
      operations: [],
      scannedEvents: 0,
      oldestTimestamp: null,
      hasMore: false,
      mode: "list"
    }
  }

  const chrono = mapDbEventsChronological(events)
  const operations = filterOperations(excludeSystemPipelines(buildOperationsFromEvents(chrono)), opts)

  return {
    operations,
    scannedEvents: events.length,
    oldestTimestamp: events[events.length - 1]?.created_at ?? null,
    hasMore: events.length >= limit,
    mode: "list"
  }
}
