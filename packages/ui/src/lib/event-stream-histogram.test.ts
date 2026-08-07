import { describe, expect, it } from "vitest"
import type { LogEntry } from "../types"
import {
  applyHistogramBrushMove,
  applyHistogramBrushResize,
  buildEventStreamHistogram,
  formatHistogramBound,
  formatHistogramBoundPair,
  histogramBucketCountForWidth,
  histogramBucketIndexAtRatio,
  histogramEdgeHitBuckets,
  histogramFocusFromBucketRange,
  histogramTimeAtRatio,
  modelFromHistogramApi,
  nudgeHistogramSelection,
  resolveHistogramBrushKind,
  resizeHistogramSelectionEdge,
} from "./event-stream-histogram"

function log(timestamp: string, type = "api", error = false): LogEntry {
  return {
    type,
    message: "m",
    timestamp,
    error: error || undefined,
    eventName: `${type}.request`,
  }
}

describe("histogramBucketCountForWidth", () => {
  it("clamps to 24..96", () => {
    expect(histogramBucketCountForWidth(40)).toBe(24)
    expect(histogramBucketCountForWidth(500)).toBe(96)
    expect(histogramBucketCountForWidth(250)).toBe(50)
  })
})

describe("buildEventStreamHistogram", () => {
  const since = "2026-08-06T16:00:00.000Z"
  const until = "2026-08-06T17:00:00.000Z"

  it("returns empty buckets for invalid bounds", () => {
    const model = buildEventStreamHistogram([], { since: "not-a-date" }, 10)
    expect(model.buckets).toEqual([])
    expect(model.maxCount).toBe(0)
    expect(model.totalCount).toBe(0)
  })

  it("spreads events across buckets with lane stacks", () => {
    const logs = [
      log("2026-08-06T16:00:00.000Z", "api"),
      log("2026-08-06T16:30:00.000Z", "sync"),
      log("2026-08-06T16:59:59.000Z", "api"),
    ]
    const model = buildEventStreamHistogram(logs, { since, until }, 4)
    expect(model.buckets).toHaveLength(4)
    expect(model.totalCount).toBe(3)
    expect(model.buckets[0]!.byLane.api).toBe(1)
    expect(model.buckets[2]!.byLane.sync).toBe(1)
    expect(model.buckets[3]!.byLane.api).toBe(1)
  })

  it("counts errors separately", () => {
    const logs = [
      log("2026-08-06T16:10:00.000Z", "api", true),
      log("2026-08-06T16:10:01.000Z", "api"),
      log("2026-08-06T16:10:02.000Z", "run", true),
    ]
    const model = buildEventStreamHistogram(logs, { since, until }, 6)
    const filled = model.buckets.find((b) => b.count > 0)!
    expect(filled.count).toBe(3)
    expect(filled.errorCount).toBe(2)
    expect(filled.byLane.api).toBe(2)
    expect(filled.byLane.run).toBe(1)
  })
})

describe("modelFromHistogramApi", () => {
  it("maps wire buckets into the strip model", () => {
    const model = modelFromHistogramApi({
      since: "2026-08-06T16:00:00.000Z",
      until: "2026-08-06T17:00:00.000Z",
      bucketCount: 2,
      totalCount: 5,
      truncated: true,
      buckets: [
        {
          start: "2026-08-06T16:00:00.000Z",
          end: "2026-08-06T16:30:00.000Z",
          count: 2,
          errorCount: 1,
          byLane: {
            run: 0,
            step: 0,
            sync: 0,
            bridge: 0,
            agent: 0,
            api: 2,
            system: 0,
          },
        },
        {
          start: "2026-08-06T16:30:00.000Z",
          end: "2026-08-06T17:00:00.000Z",
          count: 3,
          errorCount: 0,
          byLane: {
            run: 1,
            step: 0,
            sync: 2,
            bridge: 0,
            agent: 0,
            api: 0,
            system: 0,
          },
        },
      ],
    })
    expect(model.totalCount).toBe(5)
    expect(model.truncated).toBe(true)
    expect(model.maxCount).toBe(3)
    expect(model.buckets[1]!.byLane.sync).toBe(2)
  })
})

describe("formatHistogramBound", () => {
  /** Local calendar ms — avoids TZ shifting ISO fixtures across midnight. */
  function localAt(
    y: number,
    m: number,
    d: number,
    h: number,
    min: number,
  ): number {
    return new Date(y, m - 1, d, h, min, 0, 0).getTime()
  }

  const todayNoon = localAt(2026, 8, 6, 12, 0)

  it("uses time only for today's same-day window", () => {
    const start = localAt(2026, 8, 6, 7, 35)
    const end = localAt(2026, 8, 6, 11, 50)
    const label = formatHistogramBound(start, end, { nowMs: todayNoon })
    expect(label).toBe(formatHistogramBound(start, end, { nowMs: todayNoon, includeDate: false }))
    expect(label).toMatch(/07:35|7:35/)
  })

  it("includes the date for a past same-day window on the start bound", () => {
    const start = localAt(2026, 8, 5, 7, 35)
    const end = localAt(2026, 8, 5, 11, 50)
    const pair = formatHistogramBoundPair(start, end, todayNoon)
    expect(pair.start).toMatch(/5/)
    expect(pair.start).toMatch(/07:35|7:35/)
    expect(pair.end).not.toMatch(/5,/)
    expect(pair.end).toMatch(/11:50/)
  })

  it("dates both bounds when the window spans midnight", () => {
    const start = localAt(2026, 8, 4, 23, 0)
    const end = localAt(2026, 8, 5, 2, 0)
    const pair = formatHistogramBoundPair(start, end, todayNoon)
    expect(pair.start).toMatch(/4/)
    expect(pair.end).toMatch(/5/)
  })
})

describe("histogram brush helpers", () => {
  const model = buildEventStreamHistogram(
    [log("2026-08-06T16:30:00.000Z")],
    {
      since: "2026-08-06T16:00:00.000Z",
      until: "2026-08-06T17:00:00.000Z",
    },
    4,
  )

  it("maps ratio to time and bucket index", () => {
    expect(histogramTimeAtRatio(model, 0)).toBe(model.startMs)
    expect(histogramTimeAtRatio(model, 1)).toBe(model.endMs)
    expect(histogramBucketIndexAtRatio(model, 0)).toBe(0)
    expect(histogramBucketIndexAtRatio(model, 0.99)).toBe(3)
  })

  it("builds ISO focus from bucket range", () => {
    const focus = histogramFocusFromBucketRange(model, 1, 2)
    expect(focus).not.toBeNull()
    expect(Date.parse(focus!.since)).toBe(model.buckets[1]!.startMs)
    expect(Date.parse(focus!.until)).toBe(model.buckets[2]!.endMs)
  })

  it("resolves paint vs resize vs move from selection geometry", () => {
    const sel = { a: 1, b: 3 }
    expect(resolveHistogramBrushKind(0, sel, 4, 1)).toBe("paint")
    expect(resolveHistogramBrushKind(1, sel, 4, 1)).toBe("resize-start")
    expect(resolveHistogramBrushKind(2, sel, 4, 1)).toBe("move")
    expect(resolveHistogramBrushKind(3, sel, 4, 1)).toBe("resize-end")
  })

  it("moves and resizes selections without leaving the rail", () => {
    expect(applyHistogramBrushMove(1, 2, 1, 2, 4)).toEqual({ a: 2, b: 3 })
    expect(applyHistogramBrushMove(0, 1, 0, -2, 4)).toEqual({ a: 0, b: 1 })
    expect(applyHistogramBrushResize("start", 1, 3, 0, 4)).toEqual({ a: 0, b: 3 })
    expect(applyHistogramBrushResize("end", 1, 3, 1, 4)).toEqual({ a: 1, b: 1 })
  })

  it("nudges and edge-resizes via keyboard helpers", () => {
    expect(nudgeHistogramSelection({ a: 1, b: 2 }, 4, 1)).toEqual({ a: 2, b: 3 })
    expect(resizeHistogramSelectionEdge({ a: 1, b: 2 }, 4, "start", -1)).toEqual({
      a: 0,
      b: 2,
    })
    expect(histogramEdgeHitBuckets(48, 240)).toBeGreaterThanOrEqual(1)
  })
})
