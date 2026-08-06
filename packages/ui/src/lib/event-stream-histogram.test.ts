import { describe, expect, it } from "vitest"
import type { LogEntry } from "../types"
import {
  buildEventStreamHistogram,
  histogramBucketCountForWidth,
  histogramBucketIndexAtRatio,
  histogramFocusFromBucketRange,
  histogramTimeAtRatio,
} from "./event-stream-histogram"

function log(timestamp: string, error = false): LogEntry {
  return {
    type: "api",
    message: "m",
    timestamp,
    error: error || undefined,
    eventName: "api.request",
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
  })

  it("spreads events across buckets", () => {
    const logs = [
      log("2026-08-06T16:00:00.000Z"),
      log("2026-08-06T16:30:00.000Z"),
      log("2026-08-06T16:59:59.000Z"),
    ]
    const model = buildEventStreamHistogram(logs, { since, until }, 4)
    expect(model.buckets).toHaveLength(4)
    expect(model.buckets.reduce((n, b) => n + b.count, 0)).toBe(3)
    expect(model.buckets[0]!.count).toBe(1)
    expect(model.buckets[2]!.count).toBe(1)
    expect(model.buckets[3]!.count).toBe(1)
    expect(model.maxCount).toBe(1)
  })

  it("counts errors separately", () => {
    const logs = [
      log("2026-08-06T16:10:00.000Z", true),
      log("2026-08-06T16:10:01.000Z"),
      log("2026-08-06T16:10:02.000Z", true),
    ]
    const model = buildEventStreamHistogram(logs, { since, until }, 6)
    const filled = model.buckets.find((b) => b.count > 0)!
    expect(filled.count).toBe(3)
    expect(filled.errorCount).toBe(2)
  })

  it("puts all events in one bucket when span collapses them", () => {
    const t = "2026-08-06T16:15:00.000Z"
    const model = buildEventStreamHistogram(
      [log(t), log(t), log(t)],
      { since, until },
      10,
    )
    const filled = model.buckets.filter((b) => b.count > 0)
    expect(filled).toHaveLength(1)
    expect(filled[0]!.count).toBe(3)
    expect(model.maxCount).toBe(3)
  })

  it("uses now when until is omitted", () => {
    const now = Date.parse("2026-08-06T18:00:00.000Z")
    const model = buildEventStreamHistogram(
      [log("2026-08-06T16:30:00.000Z")],
      { since },
      4,
      now,
    )
    expect(model.endMs).toBe(now)
    expect(model.buckets.some((b) => b.count === 1)).toBe(true)
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
})
