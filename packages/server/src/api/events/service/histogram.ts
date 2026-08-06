/**
 * Event Stream density aggregation — full-window buckets with lane stacks.
 * Cap keeps the scan bounded; `truncated` tells the UI when more exist.
 */

import {
  EVENT_STREAM_LANES,
  emptyLaneCounts,
  eventStreamLane,
  type EventStreamLane,
} from "@mia/shared-types"
import { parseBoundaryJson } from "../../../internal/parse-json.js"
import { sameUpn } from "../../../internal/upn.js"
import * as db from "../../../infra/persistence/sqlite.js"

export const EVENT_HISTOGRAM_SCAN_CAP = 25_000

export type EventHistogramBucket = {
  start: string
  end: string
  count: number
  errorCount: number
  byLane: Record<EventStreamLane, number>
}

export type EventHistogramResult = {
  since: string
  until: string
  bucketCount: number
  totalCount: number
  truncated: boolean
  buckets: EventHistogramBucket[]
}

export type EventHistogramQuery = {
  since: string
  until: string
  bucketCount: number
  viewingAsUpn: string
  excludeTypes?: string[]
  typePatterns?: string[]
  q?: string
  errorsOnly?: boolean
}

function isErrorEvent(type: string, data: Record<string, unknown>): boolean {
  if (data["severity"] === "error") return true
  if (typeof data["error"] === "string" && data["error"].length > 0) return true
  if (type.includes(".failed") || type.endsWith(".error")) return true
  return false
}

function matchesTypePatterns(type: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith("%")) {
      const prefix = pattern.slice(0, -1)
      if (type.startsWith(prefix) || type.includes(prefix)) return true
      continue
    }
    if (type === pattern || type.startsWith(pattern)) return true
  }
  return false
}

function matchesSearch(type: string, dataJson: string, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter((w) => w.length >= 2)
  if (words.length === 0) return true
  const hay = `${type} ${dataJson}`.toLowerCase()
  return words.every((w) => hay.includes(w))
}

function visibleToViewer(actorUpn: string | null, viewingAsUpn: string): boolean {
  if (!actorUpn || !actorUpn.trim()) return true
  return sameUpn(actorUpn, viewingAsUpn)
}

export async function buildEventHistogram(
  query: EventHistogramQuery,
): Promise<EventHistogramResult> {
  const startMs = Date.parse(query.since)
  const endMs = Date.parse(query.until)
  const n = Math.max(1, Math.min(96, Math.floor(query.bucketCount)))
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return {
      since: query.since,
      until: query.until,
      bucketCount: n,
      totalCount: 0,
      truncated: false,
      buckets: [],
    }
  }

  // listEvents (not search) — search is hard-capped at 1k; density needs a wider scan.
  const rows = await db.listEvents({
    limit: EVENT_HISTOGRAM_SCAN_CAP,
    since: query.since,
    until: query.until,
    excludeTypes: query.excludeTypes,
  })

  const span = endMs - startMs
  const buckets: EventHistogramBucket[] = Array.from({ length: n }, (_, i) => {
    const bStart = startMs + (span * i) / n
    const bEnd = startMs + (span * (i + 1)) / n
    return {
      start: new Date(bStart).toISOString(),
      end: new Date(bEnd).toISOString(),
      count: 0,
      errorCount: 0,
      byLane: emptyLaneCounts(),
    }
  })

  let totalCount = 0
  for (const row of rows) {
    if (!visibleToViewer(row.actor_upn, query.viewingAsUpn)) continue
    if (query.typePatterns?.length && !matchesTypePatterns(row.type, query.typePatterns)) {
      continue
    }
    if (query.q && !matchesSearch(row.type, row.data, query.q)) continue

    const data = parseBoundaryJson(row.data) as Record<string, unknown>
    const err = isErrorEvent(row.type, data)
    if (query.errorsOnly && !err) continue

    const t = Date.parse(row.created_at)
    if (!Number.isFinite(t) || t < startMs || t > endMs) continue

    let idx = Math.floor(((t - startMs) / span) * n)
    if (idx >= n) idx = n - 1
    if (idx < 0) idx = 0
    const bucket = buckets[idx]!
    const lane = eventStreamLane(row.type)
    bucket.count += 1
    bucket.byLane[lane] += 1
    if (err) bucket.errorCount += 1
    totalCount += 1
  }

  return {
    since: query.since,
    until: query.until,
    bucketCount: n,
    totalCount,
    truncated: rows.length >= EVENT_HISTOGRAM_SCAN_CAP,
    buckets,
  }
}

export { EVENT_STREAM_LANES }
