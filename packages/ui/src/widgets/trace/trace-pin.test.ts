import { describe, expect, it } from "vitest"
import {
  TRACE_STICKY_ROW_H,
  computePinnedFromEntries,
  expandPathForScope,
  withScopeEnds,
} from "./trace-pin.js"

const H = TRACE_STICKY_ROW_H

describe("withScopeEnds", () => {
  it("ends a nested scope at the next sibling / uncle", () => {
    const ends = withScopeEnds([
      { id: "trace", top: 0, depth: 0 },
      { id: "context", top: 34, depth: 1 },
      { id: "prompt", top: 68, depth: 2 },
      { id: "tools", top: 200, depth: 2 },
      { id: "call:0", top: 400, depth: 1 },
    ])
    expect(ends.map((e) => [e.id, e.end])).toEqual([
      ["trace", Number.POSITIVE_INFINITY],
      ["context", 400],
      ["prompt", 200],
      ["tools", 400],
      ["call:0", Number.POSITIVE_INFINITY],
    ])
  })
})

describe("computePinnedFromEntries — Cursor JSON sticky (ancestor chain)", () => {
  // Trace → Context/Calls → Sent/Received → Message
  const tree = [
    { id: "trace", top: 0, depth: 0 },
    { id: "context", top: 34, depth: 1 },
    { id: "prompt", top: 68, depth: 2 },
    { id: "tools", top: 200, depth: 2 },
    { id: "call:0", top: 400, depth: 1 },
    { id: "sent:0", top: 434, depth: 2 },
    { id: "message:0:m:0", top: 468, depth: 3 },
    { id: "received:0", top: 800, depth: 2 },
    { id: "call:1", top: 1000, depth: 1 },
    { id: "sent:1", top: 1034, depth: 2 },
    { id: "message:1:m:0", top: 1068, depth: 3 },
  ]

  it("pins Trace + Context + Tools inside Tools (prompt unsticks)", () => {
    const scrollTop = 280
    expect(computePinnedFromEntries(tree, scrollTop)).toEqual([
      "trace",
      "context",
      "tools",
    ])
  })

  it("pins Trace → Call → Sent → System while reading a long message", () => {
    // Deep inside message:1:m:0 body (before call end / next sibling)
    const scrollTop = 1200
    expect(computePinnedFromEntries(tree, scrollTop)).toEqual([
      "trace",
      "call:1",
      "sent:1",
      "message:1:m:0",
    ])
  })

  it("after jumping to Call, still shows Trace above Call", () => {
    // Call header in view; next child far enough that it has not reached the stack yet
    const spaced = [
      { id: "trace", top: 0, depth: 0 },
      { id: "call:1", top: 1000, depth: 1 },
      { id: "sent:1", top: 1200, depth: 2 },
      { id: "message:1:m:0", top: 1300, depth: 3 },
    ]
    const scrollTop = 1000 - H // Call sits under Trace pin
    expect(computePinnedFromEntries(spaced, scrollTop)).toEqual([
      "trace",
      "call:1",
    ])
  })

  it("pins Call0 → Received while still inside that call", () => {
    const scrollTop = 850
    expect(computePinnedFromEntries(tree, scrollTop)).toEqual([
      "trace",
      "call:0",
      "received:0",
    ])
  })

  it("chains stick timing under an active parent", () => {
    const spaced = [
      { id: "trace", top: 0, depth: 0 },
      { id: "call:0", top: 34, depth: 1 },
      { id: "sent:0", top: 134, depth: 2 },
      { id: "message:0:m:0", top: 234, depth: 3 },
    ]
    const sentStick = 134 - 2 * H // under Trace + Call
    expect(computePinnedFromEntries(spaced, sentStick - 1)).toEqual([
      "trace",
      "call:0",
    ])
    expect(computePinnedFromEntries(spaced, sentStick)).toEqual([
      "trace",
      "call:0",
      "sent:0",
    ])
    const msgStick = 234 - 3 * H
    expect(computePinnedFromEntries(spaced, msgStick)).toEqual([
      "trace",
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
  })
})

describe("expandPathForScope", () => {
  it("expands call + sent + message", () => {
    expect(expandPathForScope("message:1:m:0")).toEqual({
      callIndex: 1,
      sent: true,
      messageKey: "1:m:0",
    })
  })

  it("expands context prompt", () => {
    expect(expandPathForScope("prompt")).toEqual({
      preamble: true,
      contextPrompt: true,
    })
  })

  it("expands tool id for received branch", () => {
    expect(expandPathForScope("tool:abc")).toEqual({
      toolId: "abc",
      received: true,
    })
  })
})
