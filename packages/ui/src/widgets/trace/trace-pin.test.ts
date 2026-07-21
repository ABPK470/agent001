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

describe("computePinnedFromEntries — structural ancestor chain only", () => {
  const tree = [
    { id: "context", top: 0, depth: 0 },
    { id: "prompt", top: 40, depth: 1 },
    { id: "tools", top: 200, depth: 1 },
    { id: "call:0", top: 400, depth: 0 },
    { id: "sent:0", top: 440, depth: 1 },
    { id: "received:0", top: 800, depth: 1 },
    { id: "call:1", top: 1000, depth: 0 },
    { id: "sent:1", top: 1040, depth: 1 },
  ]

  it("pins nothing at the top of the document", () => {
    expect(computePinnedFromEntries(tree, 0)).toEqual([])
  })

  it("pins Context + Tools inside Tools (prompt unsticks)", () => {
    expect(computePinnedFromEntries(tree, 280)).toEqual(["context", "tools"])
  })

  it("pins Call → Sent while reading long sent content", () => {
    expect(computePinnedFromEntries(tree, 600)).toEqual(["call:0", "sent:0"])
  })

  it("does not pin Call until its header has scrolled past the slot", () => {
    expect(computePinnedFromEntries(tree, 1000)).toEqual([])
    expect(computePinnedFromEntries(tree, 1000 + 1)).toEqual(["call:1"])
  })

  it("pins Call → Received while still inside that call", () => {
    expect(computePinnedFromEntries(tree, 850)).toEqual([
      "call:0",
      "received:0",
    ])
  })

  it("chains stick timing under an active parent", () => {
    const spaced = [
      { id: "call:0", top: 0, depth: 0 },
      { id: "sent:0", top: 100, depth: 1 },
      { id: "received:0", top: 200, depth: 1 },
    ]
    const sentStick = 100 - H
    expect(computePinnedFromEntries(spaced, sentStick)).toEqual(["call:0"])
    expect(computePinnedFromEntries(spaced, sentStick + 1)).toEqual([
      "call:0",
      "sent:0",
    ])
  })

  it("caps the stack and prefers inner scopes", () => {
    const deep = [
      { id: "a", top: 0, depth: 0 },
      { id: "b", top: 10, depth: 1 },
      { id: "c", top: 20, depth: 2 },
      { id: "d", top: 30, depth: 3 },
      { id: "e", top: 40, depth: 4 },
    ]
    expect(computePinnedFromEntries(deep, 500, H, 3)).toEqual(["c", "d", "e"])
  })
})

describe("expandPathForScope", () => {
  it("expands call + sent", () => {
    expect(expandPathForScope("sent:1")).toEqual({ callIndex: 1, sent: true })
  })

  it("expands context prompt", () => {
    expect(expandPathForScope("prompt")).toEqual({
      preamble: true,
      contextPrompt: true,
    })
  })
})
