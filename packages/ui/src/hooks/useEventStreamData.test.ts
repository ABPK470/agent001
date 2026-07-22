import { describe, expect, it } from "vitest"
import {
  EVENT_STREAM_LIVE_LOOKBACK_MS,
  mergeLogEntries,
  sinceForRange,
} from "./useEventStreamData"

describe("useEventStreamData helpers", () => {
  it("sinceForRange(live) is ~1h lookback", () => {
    const now = Date.parse("2026-07-22T12:00:00.000Z")
    const since = sinceForRange("live", now)
    expect(Date.parse(since)).toBe(now - EVENT_STREAM_LIVE_LOOKBACK_MS)
  })

  it("sinceForRange(15m) is 15 minutes", () => {
    const now = Date.parse("2026-07-22T12:00:00.000Z")
    const since = sinceForRange("15m", now)
    expect(Date.parse(since)).toBe(now - 15 * 60 * 1000)
  })

  it("mergeLogEntries dedupes and sorts ascending", () => {
    const a = {
      type: "step",
      message: "query_mssql started",
      timestamp: "2026-07-22T11:00:01.000Z",
      eventName: "step.started",
    }
    const b = {
      type: "step",
      message: "query_mssql completed",
      timestamp: "2026-07-22T11:00:02.000Z",
      eventName: "step.completed",
    }
    const merged = mergeLogEntries([b, a], [a])
    expect(merged.map((e) => e.eventName)).toEqual(["step.started", "step.completed"])
  })
})
