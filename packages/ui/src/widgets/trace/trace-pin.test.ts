import { describe, expect, it } from "vitest"
import {
  computePinnedFromEntries,
  expandPathForScope,
} from "./trace-pin.js"

describe("computePinnedFromEntries", () => {
  const entries = [
    { id: "context", top: 0 },
    { id: "call:0", top: 40 },
    { id: "sent:0", top: 80 },
    { id: "received:0", top: 200 },
    { id: "call:1", top: 400 },
    { id: "sent:1", top: 440 },
    { id: "received:1", top: 600 },
    { id: "call:2", top: 800 },
    { id: "sent:2", top: 840 },
  ]

  it("pins only context at the top", () => {
    expect(computePinnedFromEntries(entries, 0)).toEqual(["context"])
  })

  it("builds Call1 → Sent → Received before Call2 appears", () => {
    expect(computePinnedFromEntries(entries, 220)).toEqual([
      "context",
      "call:0",
      "sent:0",
      "received:0",
    ])
  })

  it("inserts Call2 between Call1 Received and Call2 Sent (no false nesting)", () => {
    // Scrolled into Call 2's Sent — must show Call 2 header, not look like
    // Call 1 owns a second Sent.
    expect(computePinnedFromEntries(entries, 850)).toEqual([
      "context",
      "call:0",
      "sent:0",
      "received:0",
      "call:1",
      "sent:1",
      "received:1",
      "call:2",
      "sent:2",
    ])
  })

  it("unsticks later scopes when scrolling back up", () => {
    expect(computePinnedFromEntries(entries, 450)).toEqual([
      "context",
      "call:0",
      "sent:0",
      "received:0",
      "call:1",
      "sent:1",
    ])
  })
})

describe("expandPathForScope", () => {
  it("expands call + sent", () => {
    expect(expandPathForScope("sent:1")).toEqual({ callIndex: 1, sent: true })
  })

  it("expands context", () => {
    expect(expandPathForScope("context")).toEqual({ preamble: true })
  })
})
