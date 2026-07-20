import { describe, expect, it } from "vitest"
import {
  computePinnedFromEntries,
  expandPathForScope,
} from "./trace-pin.js"

describe("computePinnedFromEntries", () => {
  const entries = [
    { id: "context", kind: "context" as const, callIndex: null, top: 0 },
    { id: "call:0", kind: "call" as const, callIndex: 0, top: 40 },
    { id: "sent:0", kind: "sent" as const, callIndex: 0, top: 80 },
    { id: "received:0", kind: "received" as const, callIndex: 0, top: 200 },
    { id: "call:1", kind: "call" as const, callIndex: 1, top: 400 },
    { id: "call:2", kind: "call" as const, callIndex: 2, top: 600 },
    { id: "sent:2", kind: "sent" as const, callIndex: 2, top: 640 },
    { id: "received:2", kind: "received" as const, callIndex: 2, top: 800 },
  ]

  it("pins context at scrollTop 0", () => {
    expect(computePinnedFromEntries(entries, 0)).toEqual(["context"])
  })

  it("accumulates parent calls without skipping", () => {
    expect(computePinnedFromEntries(entries, 50)).toEqual(["context", "call:0"])
    expect(computePinnedFromEntries(entries, 420)).toEqual([
      "context",
      "call:0",
      "call:1",
    ])
    expect(computePinnedFromEntries(entries, 620)).toEqual([
      "context",
      "call:0",
      "call:1",
      "call:2",
    ])
  })

  it("nests Sent/Received only under the current call", () => {
    expect(computePinnedFromEntries(entries, 220)).toEqual([
      "context",
      "call:0",
      "sent:0",
      "received:0",
    ])
    expect(computePinnedFromEntries(entries, 850)).toEqual([
      "context",
      "call:0",
      "call:1",
      "call:2",
      "sent:2",
      "received:2",
    ])
  })
})

describe("expandPathForScope", () => {
  it("expands call only", () => {
    expect(expandPathForScope("call:2")).toEqual({ callIndex: 2 })
  })

  it("expands call + sent", () => {
    expect(expandPathForScope("sent:1")).toEqual({ callIndex: 1, sent: true })
  })

  it("expands call + received", () => {
    expect(expandPathForScope("received:0")).toEqual({
      callIndex: 0,
      received: true,
    })
  })

  it("expands context", () => {
    expect(expandPathForScope("context")).toEqual({ preamble: true })
  })
})
