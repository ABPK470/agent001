import { describe, expect, it } from "vitest"
import {
  EVENT_STREAM_LIVE_LOOKBACK_MS,
  endOfLocalDay,
  mergeLogEntries,
  resolveWindowBounds,
  sinceForRange,
  startOfLocalDay,
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

  it("resolveWindowBounds follows live for preset live", () => {
    const b = resolveWindowBounds({ range: "live" })
    expect(b.followLive).toBe(true)
    expect(b.until).toBeUndefined()
  })

  it("resolveWindowBounds uses From/Until calendar days", () => {
    const b = resolveWindowBounds({ range: "live", from: "2026-07-01", to: "2026-07-02" })
    expect(b.followLive).toBe(false)
    expect(b.since).toBe(startOfLocalDay("2026-07-01"))
    expect(b.until).toBe(endOfLocalDay("2026-07-02"))
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
