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
      { id: "context", top: 0, depth: 0 },
      { id: "prompt", top: 40, depth: 1 },
      { id: "tools", top: 200, depth: 1 },
      { id: "call:0", top: 400, depth: 0 },
    ])
    expect(ends.map((e) => [e.id, e.end])).toEqual([
      ["context", 400],
      ["prompt", 200],
      ["tools", 400],
      ["call:0", Number.POSITIVE_INFINITY],
    ])
  })
})

describe("computePinnedFromEntries — VS Code sticky (ancestor chain)", () => {
  const tree = [
    { id: "context", top: 0, depth: 0 },
    { id: "prompt", top: 40, depth: 1 },
    { id: "tools", top: 200, depth: 1 },
    { id: "call:0", top: 400, depth: 0 },
    { id: "sent:0", top: 440, depth: 1 },
    { id: "message:0:m:0", top: 480, depth: 2 },
    { id: "received:0", top: 800, depth: 1 },
    { id: "call:1", top: 1000, depth: 0 },
    { id: "sent:1", top: 1040, depth: 1 },
    { id: "message:1:m:0", top: 1080, depth: 2 },
  ]

  it("pins nothing at the top of the document (no duplicate headers)", () => {
    expect(computePinnedFromEntries(tree, 0)).toEqual([])
  })

  it("pins Context + Tools inside Tools (prompt unsticks)", () => {
    const scrollTop = 280
    expect(computePinnedFromEntries(tree, scrollTop)).toEqual([
      "context",
      "tools",
    ])
  })

  it("pins Call → Sent → Message while reading a long message", () => {
    const scrollTop = 1200
    expect(computePinnedFromEntries(tree, scrollTop)).toEqual([
      "call:1",
      "sent:1",
      "message:1:m:0",
    ])
  })

  it("does not pin Call until its header has scrolled past the stack slot", () => {
    // Call header still sits in the first slot — in-flow shows it.
    expect(computePinnedFromEntries(tree, 1000)).toEqual([])
    // Past Call header: Call pins.
    expect(computePinnedFromEntries(tree, 1000 + 1)).toEqual(["call:1"])
  })

  it("pins Call → Received while still inside that call", () => {
    const scrollTop = 850
    expect(computePinnedFromEntries(tree, scrollTop)).toEqual([
      "call:0",
      "received:0",
    ])
  })

  it("chains stick timing under an active parent", () => {
    const spaced = [
      { id: "call:0", top: 0, depth: 0 },
      { id: "sent:0", top: 100, depth: 1 },
      { id: "message:0:m:0", top: 200, depth: 2 },
    ]
    const sentStick = 100 - H
    expect(computePinnedFromEntries(spaced, sentStick)).toEqual(["call:0"])
    expect(computePinnedFromEntries(spaced, sentStick + 1)).toEqual([
      "call:0",
      "sent:0",
    ])
    const msgStick = 200 - 2 * H
    expect(computePinnedFromEntries(spaced, msgStick + 1)).toEqual([
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
  })

  it("caps the stack and prefers inner scopes", () => {
    const deep = [
      { id: "a", top: 0, depth: 0 },
      { id: "b", top: 10, depth: 1 },
      { id: "c", top: 20, depth: 2 },
      { id: "d", top: 30, depth: 3 },
      { id: "e", top: 40, depth: 4 },
      { id: "f", top: 50, depth: 5 },
    ]
    expect(computePinnedFromEntries(deep, 500, H, 3)).toEqual(["d", "e", "f"])
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
