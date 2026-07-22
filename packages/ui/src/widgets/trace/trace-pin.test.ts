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

  it("does not pin Call until its header has fully scrolled past the slot", () => {
    expect(computePinnedFromEntries(tree, 1000 + H - 1)).toEqual([])
    expect(computePinnedFromEntries(tree, 1000 + H)).toEqual(["call:1"])
  })

  it("pins Call → Received while still inside that call", () => {
    expect(computePinnedFromEntries(tree, 850)).toEqual([
      "call:0",
      "received:0",
    ])
  })

  it("chains stick timing under an active parent — fully past header", () => {
    const spaced = [
      { id: "call:0", top: 0, depth: 0 },
      { id: "sent:0", top: 100, depth: 1 },
      { id: "received:0", top: 200, depth: 1 },
    ]
    // Sent header top is 100; sticks once top + rowH clears the slot (≥).
    expect(computePinnedFromEntries(spaced, 99)).toEqual(["call:0"])
    expect(computePinnedFromEntries(spaced, 100)).toEqual([
      "call:0",
      "sent:0",
    ])
  })

  it("yields a peer pin before the next header is covered", () => {
    // Context must release when Plan's header reaches the pin slot —
    // otherwise opaque Context covers "Plan" and Timeline looks nested under it.
    const peers = [
      { id: "context", top: 0, depth: 0 },
      { id: "phase-plan", top: 400, depth: 0 },
      { id: "call:0", top: 800, depth: 0 },
    ]
    // Plan header at the bottom of a 1-line pin stack — Context already yielded
    expect(computePinnedFromEntries(peers, 400 - H)).toEqual([])
    // Still inside Context body — Context pinned, Plan not yet at the slot
    expect(computePinnedFromEntries(peers, 300)).toEqual(["context"])
    // Plan header has reached the pin zone — Context yields (no cover)
    expect(computePinnedFromEntries(peers, 400 - H + 1)).toEqual([])
    // Plan fully past its own header — Plan pins (≥ clear)
    expect(computePinnedFromEntries(peers, 400 + H)).toEqual(["phase-plan"])
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

  it("pins Call → Sent → System while reading the system body", () => {
    const msgs = [
      { id: "call:0", top: 0, depth: 0 },
      { id: "sent:0", top: 40, depth: 1 },
      { id: "message:0:m:0", top: 80, depth: 2 },
      { id: "message:0:m:1", top: 400, depth: 2 },
    ]
    expect(computePinnedFromEntries(msgs, 200)).toEqual([
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
    // Peer yield: System releases; User takes the leaf slot (same depth)
    expect(computePinnedFromEntries(msgs, 400 + H)).toEqual([
      "call:0",
      "sent:0",
      "message:0:m:1",
    ])
  })
})

describe("computePinnedFromEntries — reserved band (stackInScroll: false)", () => {
  const band = { stackInScroll: false as const }

  it("does not pin a child until its header fully clears the scrollport top", () => {
    const spaced = [
      { id: "call:0", top: 0, depth: 0 },
      { id: "sent:0", top: 100, depth: 1 },
      { id: "received:0", top: 200, depth: 1 },
    ]
    // Band waits for full clear; pins at ≥ top + rowH (not strict-past).
    expect(computePinnedFromEntries(spaced, 100 + H - 1, H, 4, band)).toEqual([
      "call:0",
    ])
    expect(computePinnedFromEntries(spaced, 100 + H, H, 4, band)).toEqual([
      "call:0",
      "sent:0",
    ])
  })

  it("keeps a peer pinned until the next peer reaches the scrollport top", () => {
    const peers = [
      { id: "context", top: 0, depth: 0 },
      { id: "phase-plan", top: 400, depth: 0 },
    ]
    // Overlay yields at 400-H+1; band still holds Context through that point.
    expect(computePinnedFromEntries(peers, 300, H, 4, band)).toEqual(["context"])
    expect(computePinnedFromEntries(peers, 400 - H + 1, H, 4, band)).toEqual([
      "context",
    ])
    expect(computePinnedFromEntries(peers, 400, H, 4, band)).toEqual([])
    expect(computePinnedFromEntries(peers, 400 + H, H, 4, band)).toEqual([
      "phase-plan",
    ])
  })

  it("pins a short message header as soon as its own bottom clears (not fixed rowH)", () => {
    const band = { stackInScroll: false as const }
    const msgs = [
      { id: "call:0", top: 0, depth: 0, height: H },
      { id: "sent:0", top: 40, depth: 1, height: H },
      // Agent-like message row — shorter than ScopeRow / TRACE_STICKY_ROW_H
      { id: "message:0:m:0", top: 80, depth: 2, height: 22 },
    ]
    // Fixed-rowH stick would still wait until 80+34; real height clears at 102.
    expect(computePinnedFromEntries(msgs, 80 + 22 - 1, H, 4, band)).toEqual([
      "call:0",
      "sent:0",
    ])
    expect(computePinnedFromEntries(msgs, 80 + 22, H, 4, band)).toEqual([
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
  })
})

describe("expandPathForScope", () => {
  it("expands call + sent", () => {
    expect(expandPathForScope("sent:1")).toEqual({ callIndex: 1, sent: true })
  })

  it("expands message under sent", () => {
    expect(expandPathForScope("message:2:m:1")).toEqual({
      callIndex: 2,
      sent: true,
      messageKey: "2:m:1",
    })
  })

  it("expands context prompt", () => {
    expect(expandPathForScope("prompt")).toEqual({
      preamble: true,
      contextPrompt: true,
    })
  })
})
