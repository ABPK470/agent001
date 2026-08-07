import { describe, expect, it } from "vitest"
import {
  EVENT_STREAM_DRAWER_MIN_WIDTH,
  resolveEventStreamDetailMode,
} from "./event-stream-detail-mode"

describe("resolveEventStreamDetailMode", () => {
  it("uses drawer at and above the floor", () => {
    expect(resolveEventStreamDetailMode(EVENT_STREAM_DRAWER_MIN_WIDTH)).toBe("drawer")
    expect(resolveEventStreamDetailMode(900)).toBe("drawer")
  })

  it("falls back to inline below the floor", () => {
    expect(resolveEventStreamDetailMode(EVENT_STREAM_DRAWER_MIN_WIDTH - 1)).toBe("inline")
    expect(resolveEventStreamDetailMode(320)).toBe("inline")
    expect(resolveEventStreamDetailMode(0)).toBe("inline")
  })
})
