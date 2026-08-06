import { describe, expect, it } from "vitest"
import { formatEventStreamRowTime } from "./event-stream-time"

function localAt(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  sec = 0,
): number {
  return new Date(y, m - 1, d, h, min, sec, 0).getTime()
}

describe("formatEventStreamRowTime", () => {
  const now = localAt(2026, 8, 6, 18, 0)

  it("shows clock only for today", () => {
    const iso = new Date(localAt(2026, 8, 6, 11, 47, 19)).toISOString()
    const label = formatEventStreamRowTime(iso, { nowMs: now })
    expect(label).toMatch(/11:47:19/)
    expect(label).not.toMatch(/Aug/)
    expect(label).not.toMatch(/2026/)
  })

  it("shows short date without year for earlier this year", () => {
    const iso = new Date(localAt(2026, 8, 5, 11, 47, 19)).toISOString()
    const label = formatEventStreamRowTime(iso, { nowMs: now })
    expect(label).toMatch(/5/)
    expect(label).toMatch(/11:47:19/)
    expect(label).not.toMatch(/2026/)
  })

  it("includes year across year boundaries", () => {
    const iso = new Date(localAt(2025, 12, 31, 23, 50, 0)).toISOString()
    const label = formatEventStreamRowTime(iso, { nowMs: now })
    expect(label).toMatch(/2025/)
  })

  it("drops seconds in tiny mode", () => {
    const iso = new Date(localAt(2026, 8, 6, 11, 47, 19)).toISOString()
    const label = formatEventStreamRowTime(iso, { nowMs: now, tiny: true })
    expect(label).toMatch(/11:47/)
    expect(label).not.toMatch(/11:47:19/)
  })
})
