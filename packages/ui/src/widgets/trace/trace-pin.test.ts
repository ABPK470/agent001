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
    { id: "received:0", top: 520, depth: 1 },
    { id: "call:1", top: 700, depth: 0 },
    { id: "sent:1", top: 740, depth: 1 },
  ]

  it("pins context + tools inside Tools (prompt unsticks)", () => {
    // Focus inside tools body: past tools header, before call:0
    const scrollTop = 280
    expect(computePinnedFromEntries(tree, scrollTop)).toEqual([
      "context",
      "tools",
    ])
  })

  it("pins Call1 → Sent without keeping Context or Call0", () => {
    const deep = 740 - H // sent:1 just sticking under call:1
    expect(computePinnedFromEntries(tree, deep)).toEqual([
      "call:1",
      "sent:1",
    ])
  })

  it("pins Call0 → Received while still inside that call", () => {
    const scrollTop = 560
    expect(computePinnedFromEntries(tree, scrollTop)).toEqual([
      "call:0",
      "received:0",
    ])
  })

  it("pins Call the moment it reaches the bottom of an empty prior stack", () => {
    const spaced = [
      { id: "context", top: 0, depth: 0 },
      { id: "call:0", top: 100, depth: 0 },
    ]
    const stickAt = 100 - 0 // no prior pin when context already ended… 
    // At scrollTop just before call: context still contains focus if end=100
    expect(computePinnedFromEntries(spaced, 50)).toEqual(["context"])
    // Past context end (= call top): only call
    expect(computePinnedFromEntries(spaced, 100)).toEqual(["call:0"])
    expect(computePinnedFromEntries(spaced, stickAt)).toEqual(["call:0"])
  })

  it("chains stick timing under an active parent", () => {
    const spaced = [
      { id: "call:0", top: 0, depth: 0 },
      { id: "sent:0", top: 100, depth: 1 },
      { id: "received:0", top: 200, depth: 1 },
    ]
    const stickAt = 100 - H
    expect(computePinnedFromEntries(spaced, stickAt - 1)).toEqual(["call:0"])
    expect(computePinnedFromEntries(spaced, stickAt)).toEqual([
      "call:0",
      "sent:0",
    ])
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
