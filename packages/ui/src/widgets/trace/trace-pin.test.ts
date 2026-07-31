import { describe, expect, it } from "vitest"
import {
  TRACE_PIN_OPTS,
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

describe("computePinnedFromEntries — overlay (stackInScroll default)", () => {
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
    expect(computePinnedFromEntries(spaced, 99)).toEqual(["call:0"])
    expect(computePinnedFromEntries(spaced, 100)).toEqual([
      "call:0",
      "sent:0",
    ])
  })

  it("yields a peer pin before the next header is covered", () => {
    const peers = [
      { id: "context", top: 0, depth: 0 },
      { id: "phase-plan", top: 400, depth: 0 },
      { id: "call:0", top: 800, depth: 0 },
    ]
    expect(computePinnedFromEntries(peers, 400 - H)).toEqual([])
    expect(computePinnedFromEntries(peers, 300)).toEqual(["context"])
    expect(computePinnedFromEntries(peers, 400 - H + 1)).toEqual([])
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
    expect(computePinnedFromEntries(msgs, 400 + H)).toEqual([
      "call:0",
      "sent:0",
      "message:0:m:1",
    ])
  })
})

describe("TRACE_PIN_OPTS — reserved band (Trace path)", () => {
  it("uses stackInScroll: false (pins make space outside the scrollport)", () => {
    expect(TRACE_PIN_OPTS).toEqual({ stackInScroll: false })
  })
})

describe("computePinnedFromEntries — reserved band (stackInScroll: false)", () => {
  const band = { stackInScroll: false as const }

  it("pins a child as soon as its header top reaches the scrollport top", () => {
    const spaced = [
      { id: "call:0", top: 0, depth: 0 },
      { id: "sent:0", top: 100, depth: 1 },
      { id: "received:0", top: 200, depth: 1 },
    ]
    expect(computePinnedFromEntries(spaced, 99, H, 4, band)).toEqual(["call:0"])
    expect(computePinnedFromEntries(spaced, 100, H, 4, band)).toEqual([
      "call:0",
      "sent:0",
    ])
  })

  it("keeps a peer pinned until the next peer reaches the scrollport top", () => {
    const peers = [
      { id: "context", top: 0, depth: 0 },
      { id: "phase-plan", top: 400, depth: 0 },
    ]
    expect(computePinnedFromEntries(peers, 300, H, 4, band)).toEqual(["context"])
    expect(computePinnedFromEntries(peers, 399, H, 4, band)).toEqual(["context"])
    expect(computePinnedFromEntries(peers, 400, H, 4, band)).toEqual([
      "phase-plan",
    ])
  })

  it("pins Call → Received while reading received body", () => {
    const tree = [
      { id: "call:0", top: 0, depth: 0 },
      { id: "sent:0", top: 40, depth: 1 },
      { id: "received:0", top: 800, depth: 1 },
      { id: "call:1", top: 1000, depth: 0 },
    ]
    expect(computePinnedFromEntries(tree, 850, H, 4, band)).toEqual([
      "call:0",
      "received:0",
    ])
  })

  it("pins a short message header as soon as its top reaches the scrollport", () => {
    const msgs = [
      { id: "call:0", top: 0, depth: 0, height: H },
      { id: "sent:0", top: 40, depth: 1, height: H },
      { id: "message:0:m:0", top: 80, depth: 2, height: 22 },
    ]
    expect(computePinnedFromEntries(msgs, 79, H, 4, band)).toEqual([
      "call:0",
      "sent:0",
    ])
    expect(computePinnedFromEntries(msgs, 80, H, 4, band)).toEqual([
      "call:0",
      "sent:0",
      "message:0:m:0",
    ])
  })

  it("never pins a collapsed scope (no interior to contextualize)", () => {
    const tree = [
      { id: "call:0", top: 0, depth: 0, open: false as const },
      { id: "call:1", top: 100, depth: 0 },
    ]
    expect(computePinnedFromEntries(tree, 100, H, 4, band)).toEqual(["call:1"])
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
