/**
 * Entry point: load events from SQLite event_log, group into pipelines.
 * Single code path for list + focus (plan/run audit).
 *
 * Pagination is event-window based, but Personal scope (Viewing as) filters
 * most windows to empty. Without fill-scan, the UI infinite-scrolls dozens of
 * empty `before=` pages. One request keeps reading until it has a useful
 * pipeline page or hits an event budget.
 */

import * as db from "../../../../infra/persistence/sqlite.js"
import type { DbEvent } from "../../../../infra/persistence/db/events.js"
import {
  buildOperationsFromEvents,
  mapDbEventsChronological
} from "./build-operations-from-events.js"
import { excludeSystemPipelines, filterOperations, scopeOperationsToViewingAs } from "./filter.js"
import { listOperationsForPlan } from "./list-operations-for-plan.js"
import { listOperationsForRun } from "./list-operations-for-run.js"
import type { ListOperationsOpts, ListOperationsResult, OperationPipeline } from "./types.js"

/** Events read per REST page when scanning event_log (newest first, cursor via `before`). */
export const OPERATIONS_PAGE_EVENT_LIMIT = 2000

/** Smaller window for debounced SSE head snapshots — covers live/running work without full rescans. */
export const OPERATIONS_HEAD_EVENT_LIMIT = 1000

/** Stop fill-scan once we have about a screenful of scoped pipelines. */
export const OPERATIONS_FILL_TARGET = 40

/** Cap events scanned in one HTTP list call (avoids unbounded work). */
export const OPERATIONS_FILL_EVENT_BUDGET = 12_000

export function mergeOperationPipelinePages(
  ...groups: OperationPipeline[][]
): OperationPipeline[] {
  const byId = new Map<string, OperationPipeline>()
  for (const group of groups) {
    for (const pipeline of group) {
      const existing = byId.get(pipeline.id)
      if (!existing || pipeline.eventCount > existing.eventCount) {
        byId.set(pipeline.id, pipeline)
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function buildPage(
  events: DbEvent[],
  opts: ListOperationsOpts,
): OperationPipeline[] {
  const chrono = mapDbEventsChronological(events)
  return filterOperations(excludeSystemPipelines(buildOperationsFromEvents(chrono)), opts)
}

export function listOperations(opts: ListOperationsOpts = {}): ListOperationsResult {
  if (opts.planId) {
    const { operation, scannedEvents } = listOperationsForPlan(opts.planId)
    const scoped = scopeOperationsToViewingAs(operation ? [operation] : [], opts)
    return {
      operations: scoped,
      scannedEvents,
      oldestTimestamp: null,
      hasMore: false,
      mode: "focus"
    }
  }

  if (opts.runId) {
    const { operation, scannedEvents } = listOperationsForRun(opts.runId)
    const scoped = scopeOperationsToViewingAs(operation ? [operation] : [], opts)
    return {
      operations: scoped,
      scannedEvents,
      oldestTimestamp: null,
      hasMore: false,
      mode: "focus"
    }
  }

  const pageSize = Math.min(opts.limit ?? OPERATIONS_PAGE_EVENT_LIMIT, 10_000)
  // Viewing as (and Me) always stamps viewingAsUpn — fill-scan so sparse owners
  // do not force the client to walk the whole event_log via infinite scroll.
  const fillScan = opts.viewingAsUpn !== undefined
  const eventBudget = fillScan
    ? Math.min(Math.max(pageSize, OPERATIONS_FILL_EVENT_BUDGET), 12_000)
    : pageSize
  const targetOps = fillScan ? OPERATIONS_FILL_TARGET : Number.POSITIVE_INFINITY

  let before = opts.before
  let scannedEvents = 0
  let oldestTimestamp: string | null = null
  let hasMore = false
  const batches: OperationPipeline[][] = []

  while (scannedEvents < eventBudget) {
    const take = Math.min(pageSize, eventBudget - scannedEvents)
    const events = db.listEvents({ limit: take, before: before ?? undefined })
    if (events.length === 0) {
      hasMore = false
      break
    }

    scannedEvents += events.length
    oldestTimestamp = events[events.length - 1]?.created_at ?? oldestTimestamp
    hasMore = events.length >= take
    before = oldestTimestamp

    const page = buildPage(events, opts)
    if (page.length > 0) batches.push(page)

    if (mergeOperationPipelinePages(...batches).length >= targetOps) break
    if (!hasMore) break
  }

  return {
    operations: mergeOperationPipelinePages(...batches),
    scannedEvents,
    oldestTimestamp,
    hasMore,
    mode: "list"
  }
}
