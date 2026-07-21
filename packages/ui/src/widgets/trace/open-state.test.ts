import { describe, expect, it } from "vitest"
import { emptyOpen, seedLatest } from "./open-state.js"

describe("open-state", () => {
  it("starts collapsed with empty sets", () => {
    const o = emptyOpen()
    expect(o.preamble).toBe(false)
    expect(o.calls.size).toBe(0)
    expect(o.messages.size).toBe(0)
    expect(o.foldMode).toBe("collapsed")
  })

  it("seedLatest opens only the last call", () => {
    expect(seedLatest(0).calls.size).toBe(0)
    const o = seedLatest(3)
    expect([...o.calls]).toEqual([2])
    expect(o.sent.size).toBe(0)
  })
})
