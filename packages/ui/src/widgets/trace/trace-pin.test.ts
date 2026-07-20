import { describe, expect, it } from "vitest"
import { computePinnedScopeIds } from "./trace-pin.js"

function fakeScroll(scopes: Array<{ id: string; kind: string; call?: number; top: number }>, scrollTop: number) {
  const scrollEl = {
    scrollTop,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 400, width: 300, height: 400 }),
    querySelectorAll: () =>
      scopes.map((s) => {
        const el = {
          dataset: {
            traceScope: s.id,
            traceKind: s.kind,
            traceCall: s.call == null ? "" : String(s.call),
          },
          getBoundingClientRect: () => ({
            top: s.top - scrollTop,
            left: 0,
            right: 300,
            bottom: s.top - scrollTop + 34,
            width: 300,
            height: 34,
          }),
        }
        return el as unknown as HTMLElement
      }),
  } as unknown as HTMLElement
  return computePinnedScopeIds(scrollEl)
}

describe("computePinnedScopeIds", () => {
  const scopes = [
    { id: "context", kind: "context", top: 0 },
    { id: "call:0", kind: "call", call: 0, top: 40 },
    { id: "sent:0", kind: "sent", call: 0, top: 80 },
    { id: "received:0", kind: "received", call: 0, top: 200 },
    { id: "call:1", kind: "call", call: 1, top: 400 },
    { id: "call:2", kind: "call", call: 2, top: 600 },
    { id: "sent:2", kind: "sent", call: 2, top: 640 },
    { id: "received:2", kind: "received", call: 2, top: 800 },
  ]

  it("pins nothing at the very top before any header passes", () => {
    // scrollTop 0: context top is 0, so context is pinned (top <= scrollTop)
    expect(fakeScroll(scopes, 0)).toEqual(["context"])
  })

  it("accumulates Call 1 then Call 2 then Call 3", () => {
    expect(fakeScroll(scopes, 50)).toEqual(["context", "call:0"])
    expect(fakeScroll(scopes, 420)).toEqual(["context", "call:0", "call:1"])
    expect(fakeScroll(scopes, 620)).toEqual(["context", "call:0", "call:1", "call:2"])
  })

  it("adds Sent/Received only for the current call", () => {
    expect(fakeScroll(scopes, 220)).toEqual([
      "context",
      "call:0",
      "sent:0",
      "received:0",
    ])
    expect(fakeScroll(scopes, 850)).toEqual([
      "context",
      "call:0",
      "call:1",
      "call:2",
      "sent:2",
      "received:2",
    ])
  })
})
