/**
 * Pure Event Stream density bucketing — timestamps → fixed bins with lane stacks.
 * No React / store. Presentation strip owns paint + brush.
 */

import {
  EVENT_STREAM_LANES,
  emptyLaneCounts,
  type EventStreamLane,
} from "@mia/shared-types"
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
  byLane: Record<EventStreamLane, number>
}

export type EventStreamHistogramModel = {
  startMs: number
  endMs: number
  buckets: EventStreamHistogramBucket[]
  maxCount: number
  totalCount: number
  truncated: boolean
}

/** Wire shape from GET /api/events/histogram. */
export type EventStreamHistogramApiBucket = {
  start: string
  end: string
  count: number
  errorCount: number
  byLane: Record<EventStreamLane, number>
}

export type EventStreamHistogramApiResult = {
  since: string
  until: string
  bucketCount: number
  totalCount: number
  truncated: boolean
  buckets: EventStreamHistogramApiBucket[]
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

function normalizeByLane(
  raw: Partial<Record<EventStreamLane, number>> | undefined,
): Record<EventStreamLane, number> {
  const next = emptyLaneCounts()
  if (!raw) return next
  for (const lane of EVENT_STREAM_LANES) {
    const n = raw[lane]
    if (typeof n === "number" && n > 0) next[lane] = n
  }
  return next
}

/** Map server histogram payload into the strip model. */
export function modelFromHistogramApi(
  api: EventStreamHistogramApiResult,
): EventStreamHistogramModel {
  const startMs = parseBoundMs(api.since) ?? 0
  const endMs = parseBoundMs(api.until) ?? startMs + 1
  let maxCount = 0
  const buckets = api.buckets.map((b) => {
    const count = b.count
    if (count > maxCount) maxCount = count
    return {
      startMs: parseBoundMs(b.start) ?? startMs,
      endMs: parseBoundMs(b.end) ?? endMs,
      count,
      errorCount: b.errorCount,
      byLane: normalizeByLane(b.byLane),
    }
  })
  return {
    startMs,
    endMs,
    buckets,
    maxCount,
    totalCount: api.totalCount,
    truncated: api.truncated,
  }
}

/**
 * Bucket `logs` into `bucketCount` equal slices across `[since, until]`.
 * When `until` is omitted, use max(now, newest log) so Live windows fill.
 * Fallback when the server histogram is unavailable.
 */
export function buildEventStreamHistogram(
  logs: readonly LogEntry[],
  bounds: EventStreamHistogramBounds,
  bucketCount: number,
  nowMs: number = Date.now(),
): EventStreamHistogramModel {
  const startMs = parseBoundMs(bounds.since)
  if (startMs == null || bucketCount < 1) {
    return {
      startMs: 0,
      endMs: 0,
      buckets: [],
      maxCount: 0,
      totalCount: 0,
      truncated: false,
    }
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
    return {
      startMs,
      endMs: startMs + 1,
      buckets: [],
      maxCount: 0,
      totalCount: 0,
      truncated: false,
    }
  }

  const span = endMs - startMs
  const n = Math.max(1, Math.floor(bucketCount))
  const buckets: EventStreamHistogramBucket[] = Array.from({ length: n }, (_, i) => {
    const bStart = startMs + (span * i) / n
    const bEnd = startMs + (span * (i + 1)) / n
    return {
      startMs: bStart,
      endMs: bEnd,
      count: 0,
      errorCount: 0,
      byLane: emptyLaneCounts(),
    }
  })

  let totalCount = 0
  for (const log of logs) {
    const t = parseBoundMs(log.timestamp)
    if (t == null || t < startMs || t > endMs) continue
    let idx = Math.floor(((t - startMs) / span) * n)
    if (idx >= n) idx = n - 1
    if (idx < 0) idx = 0
    const bucket = buckets[idx]!
    bucket.count += 1
    totalCount += 1
    if (log.error) bucket.errorCount += 1
    const lane = (EVENT_STREAM_LANES as readonly string[]).includes(log.type)
      ? (log.type as EventStreamLane)
      : "system"
    bucket.byLane[lane] += 1
  }

  let maxCount = 0
  for (const bucket of buckets) {
    if (bucket.count > maxCount) maxCount = bucket.count
  }

  return {
    startMs,
    endMs,
    buckets,
    maxCount,
    totalCount,
    truncated: false,
  }
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

/** Inclusive bucket selection (a/b unordered until normalized). */
export type HistogramSelectionRange = { a: number; b: number }

export type HistogramBrushKind = "paint" | "resize-start" | "resize-end" | "move"

export function normalizeHistogramSelection(
  a: number,
  b: number,
  bucketCount: number,
): HistogramSelectionRange | null {
  if (bucketCount <= 0) return null
  const lo = Math.max(0, Math.min(a, b, bucketCount - 1))
  const hi = Math.min(bucketCount - 1, Math.max(a, b, 0))
  return { a: lo, b: hi }
}

/** Edge hit zone in buckets (~8px), clamped 1..3. */
export function histogramEdgeHitBuckets(
  bucketCount: number,
  plotWidthPx: number,
): number {
  if (bucketCount <= 0 || plotWidthPx <= 0) return 1
  const pxPerBucket = plotWidthPx / bucketCount
  return Math.max(1, Math.min(3, Math.ceil(8 / Math.max(1, pxPerBucket))))
}

/**
 * What a pointer-down on `index` should do given the current selection.
 * Outside selection → paint; near edges → resize; interior → move.
 */
export function resolveHistogramBrushKind(
  index: number,
  selection: HistogramSelectionRange | null,
  bucketCount: number,
  edgeBuckets: number,
): HistogramBrushKind {
  if (!selection || bucketCount <= 0) return "paint"
  const lo = Math.min(selection.a, selection.b)
  const hi = Math.max(selection.a, selection.b)
  if (index < lo || index > hi) return "paint"
  const edge = Math.max(1, edgeBuckets)
  const nearStart = index <= lo + edge - 1
  const nearEnd = index >= hi - edge + 1
  if (nearStart && nearEnd) {
    return index - lo <= hi - index ? "resize-start" : "resize-end"
  }
  if (nearStart) return "resize-start"
  if (nearEnd) return "resize-end"
  return "move"
}

/** Slide a selection by keeping width; clamp inside [0, n). */
export function applyHistogramBrushMove(
  startLo: number,
  startHi: number,
  grabIndex: number,
  currentIndex: number,
  bucketCount: number,
): HistogramSelectionRange {
  const width = Math.max(0, startHi - startLo)
  let lo = startLo + (currentIndex - grabIndex)
  let hi = lo + width
  if (lo < 0) {
    hi -= lo
    lo = 0
  }
  if (hi > bucketCount - 1) {
    const over = hi - (bucketCount - 1)
    lo -= over
    hi = bucketCount - 1
  }
  return normalizeHistogramSelection(lo, hi, bucketCount) ?? { a: 0, b: 0 }
}

export function applyHistogramBrushResize(
  edge: "start" | "end",
  startLo: number,
  startHi: number,
  currentIndex: number,
  bucketCount: number,
): HistogramSelectionRange {
  if (edge === "start") {
    return (
      normalizeHistogramSelection(currentIndex, startHi, bucketCount)
      ?? { a: 0, b: 0 }
    )
  }
  return (
    normalizeHistogramSelection(startLo, currentIndex, bucketCount)
    ?? { a: 0, b: 0 }
  )
}

/** Nudge the whole selection by `delta` buckets. */
export function nudgeHistogramSelection(
  selection: HistogramSelectionRange,
  bucketCount: number,
  delta: number,
): HistogramSelectionRange | null {
  const norm = normalizeHistogramSelection(selection.a, selection.b, bucketCount)
  if (!norm) return null
  return applyHistogramBrushMove(norm.a, norm.b, norm.a, norm.a + delta, bucketCount)
}

/** Grow/shrink one edge by `delta` buckets. */
export function resizeHistogramSelectionEdge(
  selection: HistogramSelectionRange,
  bucketCount: number,
  edge: "start" | "end",
  delta: number,
): HistogramSelectionRange | null {
  const norm = normalizeHistogramSelection(selection.a, selection.b, bucketCount)
  if (!norm) return null
  const nextIndex = edge === "start" ? norm.a + delta : norm.b + delta
  return applyHistogramBrushResize(edge, norm.a, norm.b, nextIndex, bucketCount)
}

/** Paint order for stacked bars — bottom → top. */
export const HISTOGRAM_STACK_ORDER: readonly EventStreamLane[] = EVENT_STREAM_LANES

function localDateKey(ms: number): string {
  return new Date(ms).toDateString()
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

/**
 * Histogram / zoom bound label — time only for today's same-day window;
 * date+time when the window is not today or spans midnight (Datadog dialect).
 *
 * For a same-day past window, callers may omit the date on the *end* bound
 * (`includeDate: false`) once the start already carries the day.
 */
export function formatHistogramBound(
  timestampMs: number,
  oppositeBoundMs: number,
  opts?: { includeDate?: boolean; nowMs?: number },
): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "—"
  const timeStr = formatClock(timestampMs)
  const nowMs = opts?.nowMs ?? Date.now()
  const spansMultipleDays = localDateKey(timestampMs) !== localDateKey(oppositeBoundMs)
  const isToday = localDateKey(timestampMs) === localDateKey(nowMs)
  const includeDate =
    opts?.includeDate ?? (spansMultipleDays || !isToday)
  if (!includeDate) return timeStr
  return `${formatShortDate(timestampMs)}, ${timeStr}`
}

/** Start/end pair for axis labels and zoom chips — one shared dialect. */
export function formatHistogramBoundPair(
  startMs: number,
  endMs: number,
  nowMs: number = Date.now(),
): { start: string; end: string } {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { start: "—", end: "—" }
  }
  const spansMultipleDays = localDateKey(startMs) !== localDateKey(endMs)
  const startToday = localDateKey(startMs) === localDateKey(nowMs)
  const endToday = localDateKey(endMs) === localDateKey(nowMs)
  const sameDayPast = !spansMultipleDays && !startToday

  return {
    start: formatHistogramBound(startMs, endMs, {
      nowMs,
      includeDate: spansMultipleDays || !startToday,
    }),
    end: formatHistogramBound(endMs, startMs, {
      nowMs,
      // Same calendar day in the past: date already on the left bound.
      includeDate: spansMultipleDays || (!sameDayPast && !endToday),
    }),
  }
}
