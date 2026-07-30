import { describe, expect, it } from "vitest"
import { sortThreadsByPinThenUpdatedAt } from "./thread-order"

describe("sortThreadsByPinThenUpdatedAt", () => {
  it("keeps pinned threads above unpinned, newest first within each group", () => {
    const ordered = sortThreadsByPinThenUpdatedAt([
      { id: "a", pinned: false, updatedAt: "2026-07-30T12:00:00.000Z" },
      { id: "b", pinned: true, updatedAt: "2026-07-29T12:00:00.000Z" },
      { id: "c", pinned: true, updatedAt: "2026-07-30T18:00:00.000Z" },
      { id: "d", pinned: false, updatedAt: "2026-07-30T20:00:00.000Z" },
    ])
    expect(ordered.map((t) => t.id)).toEqual(["c", "b", "d", "a"])
  })

  it("places a newly created unpinned thread under pinned ones", () => {
    const ordered = sortThreadsByPinThenUpdatedAt([
      { id: "new", pinned: false, updatedAt: "2026-07-30T22:00:00.000Z" },
      { id: "pin", pinned: true, updatedAt: "2026-07-01T00:00:00.000Z" },
    ])
    expect(ordered.map((t) => t.id)).toEqual(["pin", "new"])
  })
})
