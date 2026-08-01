import { describe, expect, it } from "vitest"
import { endOfLocalDay, startOfLocalDay } from "./event-stream-window.js"
import { resolveOperationsWindowBounds } from "./operations-window.js"

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
