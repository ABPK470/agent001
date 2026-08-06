/**
 * Pure Event Stream density bucketing — timestamps → fixed bins.
 * No React / store. Presentation strip owns paint + brush.
 */

import type { LogEntry } from "../types"

export type EventStreamHistogramBounds = {
  since: string
  until?: string
}

export type EventStreamHistogramBucket = {
  startMs: number
  endMs: number
  count: number
  errorCount: number
}

export type EventStreamHistogramModel = {
  startMs: number
  endMs: number
  buckets: EventStreamHistogramBucket[]
  maxCount: number
}

/** ~4–6px per bar; keep readable at narrow and wide tile widths. */
export function histogramBucketCountForWidth(widthPx: number): number {
  if (widthPx <= 0) return 48
  return Math.max(24, Math.min(96, Math.round(widthPx / 5)))
}

function parseBoundMs(iso: string): number | null {
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Bucket `logs` into `bucketCount` equal slices across `[since, until]`.
 * When `until` is omitted, use max(now, newest log) so Live windows fill.
 */
export function buildEventStreamHistogram(
  logs: readonly LogEntry[],
  bounds: EventStreamHistogramBounds,
  bucketCount: number,
  nowMs: number = Date.now(),
): EventStreamHistogramModel {
  const startMs = parseBoundMs(bounds.since)
  if (startMs == null || bucketCount < 1) {
    return { startMs: 0, endMs: 0, buckets: [], maxCount: 0 }
  }

  let endMs = bounds.until != null ? parseBoundMs(bounds.until) : null
  if (endMs == null) {
    let newest = nowMs
    for (const log of logs) {
      const t = parseBoundMs(log.timestamp)
      if (t != null && t > newest) newest = t
    }
    endMs = Math.max(newest, startMs + 1)
  }

  if (endMs <= startMs) {
    return { startMs, endMs: startMs + 1, buckets: [], maxCount: 0 }
  }

  const span = endMs - startMs
  const n = Math.max(1, Math.floor(bucketCount))
  const buckets: EventStreamHistogramBucket[] = Array.from({ length: n }, (_, i) => {
    const bStart = startMs + (span * i) / n
    const bEnd = startMs + (span * (i + 1)) / n
    return { startMs: bStart, endMs: bEnd, count: 0, errorCount: 0 }
  })

  for (const log of logs) {
    const t = parseBoundMs(log.timestamp)
    if (t == null || t < startMs || t > endMs) continue
    let idx = Math.floor(((t - startMs) / span) * n)
    if (idx >= n) idx = n - 1
    if (idx < 0) idx = 0
    const bucket = buckets[idx]!
    bucket.count += 1
    if (log.error) bucket.errorCount += 1
  }

  let maxCount = 0
  for (const bucket of buckets) {
    if (bucket.count > maxCount) maxCount = bucket.count
  }

  return { startMs, endMs, buckets, maxCount }
}

/** Map a pointer x (0..1 across the plot) to a time within the model span. */
export function histogramTimeAtRatio(
  model: EventStreamHistogramModel,
  ratio: number,
): number {
  if (model.endMs <= model.startMs) return model.startMs
  const r = Math.max(0, Math.min(1, ratio))
  return model.startMs + (model.endMs - model.startMs) * r
}

/** Bucket index under a 0..1 plot ratio (clamped). */
export function histogramBucketIndexAtRatio(
  model: EventStreamHistogramModel,
  ratio: number,
): number {
  const n = model.buckets.length
  if (n === 0) return -1
  const r = Math.max(0, Math.min(0.999999, ratio))
  return Math.floor(r * n)
}

export function histogramFocusFromBucketRange(
  model: EventStreamHistogramModel,
  fromIndex: number,
  toIndex: number,
): { since: string; until: string } | null {
  const n = model.buckets.length
  if (n === 0) return null
  const a = Math.max(0, Math.min(fromIndex, toIndex, n - 1))
  const b = Math.min(n - 1, Math.max(fromIndex, toIndex, 0))
  const start = model.buckets[a]!
  const end = model.buckets[b]!
  return {
    since: new Date(start.startMs).toISOString(),
    until: new Date(end.endMs).toISOString(),
  }
}
