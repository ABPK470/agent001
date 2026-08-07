import { describe, expect, it } from "vitest"
import { endOfLocalDay, startOfLocalDay } from "./event-stream-window.js"
import {
  formatOperationsListTimeHeader,
  resolveOperationsWindowBounds,
} from "./operations-window.js"

describe("resolveOperationsWindowBounds", () => {
  it("live is unbounded and follows", () => {
    expect(resolveOperationsWindowBounds({ range: "live" })).toEqual({
      followLive: true,
    })
  })

  it("quick ranges bind since and pause live follow", () => {
    const bounds = resolveOperationsWindowBounds({ range: "1h" })
    expect(bounds.followLive).toBe(false)
    expect(bounds.since).toBeTruthy()
    expect(bounds.until).toBeUndefined()
  })

  it("custom from/until bind day bounds", () => {
    const bounds = resolveOperationsWindowBounds({
      range: "live",
      from: "2026-07-01",
      to: "2026-07-02",
    })
    expect(bounds.followLive).toBe(false)
    expect(bounds.since).toBe(startOfLocalDay("2026-07-01"))
    expect(bounds.until).toBe(endOfLocalDay("2026-07-02"))
  })
})

describe("formatOperationsListTimeHeader", () => {
  it("labels unbounded live as Live", () => {
    expect(formatOperationsListTimeHeader({ range: "live" })).toBe("Live")
  })

  it("labels open quick ranges as start – now", () => {
    const now = Date.parse("2026-08-07T18:00:00.000Z")
    const label = formatOperationsListTimeHeader({ range: "1h" }, now)
    expect(label.endsWith(" – now")).toBe(true)
    expect(label.startsWith("Live")).toBe(false)
  })

  it("labels custom day windows with both bounds", () => {
    const label = formatOperationsListTimeHeader({
      range: "live",
      from: "2026-07-01",
      to: "2026-07-02",
    })
    expect(label).toContain(" – ")
    expect(label.endsWith(" – now")).toBe(false)
  })
})
