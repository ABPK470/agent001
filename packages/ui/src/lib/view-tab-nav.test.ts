import { describe, expect, it } from "vitest"
import { neighborViewId } from "./view-tab-nav"

const views = [{ id: "a" }, { id: "b" }, { id: "c" }]

describe("neighborViewId", () => {
  it("cycles forward and wraps", () => {
    expect(neighborViewId(views, "a", 1)).toBe("b")
    expect(neighborViewId(views, "c", 1)).toBe("a")
  })

  it("cycles backward and wraps", () => {
    expect(neighborViewId(views, "a", -1)).toBe("c")
    expect(neighborViewId(views, "b", -1)).toBe("a")
  })

  it("returns null when there is nothing to cycle", () => {
    expect(neighborViewId([{ id: "only" }], "only", 1)).toBeNull()
    expect(neighborViewId(views, "missing", 1)).toBeNull()
    expect(neighborViewId([], "a", 1)).toBeNull()
  })
})
