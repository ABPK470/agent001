import { describe, expect, it } from "vitest"
import {
  TRACE_STICKY_ROW_H,
  computePinnedFromEntries,
  expandPathForScope,
} from "./trace-pin.js"

const H = TRACE_STICKY_ROW_H

describe("computePinnedFromEntries — stick at stack bottom (no lag)", () => {
  it("pins only context at scrollTop 0 when the next header is further down", () => {
    const spaced = [
      { id: "context", top: 0 },
      { id: "call:0", top: 200 },
      { id: "sent:0", top: 400 },
    ]
    expect(computePinnedFromEntries(spaced, 0)).toEqual(["context"])
  })

  it("pins Call 1 the moment it reaches the bottom of Context (not later)", () => {
    const spaced = [
      { id: "context", top: 0 },
      { id: "call:0", top: 100 },
      { id: "sent:0", top: 200 },
    ]
    // Context pinned. Call sticks when 100 <= scrollTop + H → scrollTop >= 100 - H
    const stickAt = 100 - H
    expect(computePinnedFromEntries(spaced, stickAt - 1)).toEqual(["context"])
    expect(computePinnedFromEntries(spaced, stickAt)).toEqual([
      "context",
      "call:0",
    ])
    // Old (wrong) rule top <= scrollTop would still only have context here
    expect(stickAt < 100).toBe(true)
  })

  it("chains Call1 → Sent → Received → Call2 without skipping or lagging", () => {
    const spaced = [
      { id: "context", top: 0 },
      { id: "call:0", top: 80 },
      { id: "sent:0", top: 160 },
      { id: "received:0", top: 240 },
      { id: "call:1", top: 400 },
      { id: "sent:1", top: 480 },
    ]

    // Deep into Call2 Sent: each prior scope must already be past its
    // stack-bottom threshold.
    const deep = 480 - 5 * H // sent:1 sticks when 480 <= scrollTop + 5*H
    expect(computePinnedFromEntries(spaced, deep)).toEqual([
      "context",
      "call:0",
      "sent:0",
      "received:0",
      "call:1",
      "sent:1",
    ])
  })

  it("inserts Call2 between Call1 Received and Call2 Sent", () => {
    const spaced = [
      { id: "context", top: 0 },
      { id: "call:0", top: 40 },
      { id: "sent:0", top: 80 },
      { id: "received:0", top: 200 },
      { id: "call:1", top: 400 },
      { id: "sent:1", top: 440 },
    ]
    const scrollTop = 440 - 5 * H
    expect(computePinnedFromEntries(spaced, scrollTop)).toEqual([
      "context",
      "call:0",
      "sent:0",
      "received:0",
      "call:1",
      "sent:1",
    ])
  })

  it("unsticks when scrolling back above a scope’s stick threshold", () => {
    const spaced = [
      { id: "context", top: 0 },
      { id: "call:0", top: 100 },
      { id: "sent:0", top: 200 },
    ]
    const callStick = 100 - H
    expect(computePinnedFromEntries(spaced, callStick)).toEqual([
      "context",
      "call:0",
    ])
    expect(computePinnedFromEntries(spaced, callStick - 1)).toEqual(["context"])
  })
})

describe("expandPathForScope", () => {
  it("expands call + sent", () => {
    expect(expandPathForScope("sent:1")).toEqual({ callIndex: 1, sent: true })
  })
})
