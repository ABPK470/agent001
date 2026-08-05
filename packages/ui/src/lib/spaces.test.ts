import { describe, expect, it } from "vitest"
import {
  PRODUCT_SPACES,
  buildSpaceView,
  mergeProductSpaces,
  resetSpaceView,
  spaceByIndex,
} from "./spaces"

describe("product spaces", () => {
  it("exposes four Call Space indices", () => {
    expect(PRODUCT_SPACES.map((s) => s.index)).toEqual([1, 2, 3, 4])
    expect(spaceByIndex(2)?.id).toBe("space:observe")
  })

  it("builds curated Observe widgets", () => {
    const view = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:observe")!)
    expect(view.id).toBe("space:observe")
    expect(view.tiles.map((t) => t.type)).toEqual([
      "operation-log",
      "live-logs",
      "thread-nav",
      "debug-inspector",
    ])
    expect(view.split).not.toBeNull()
  })

  it("merges missing Spaces without wiping Main", () => {
    const main = {
      id: "default",
      name: "Main",
      tiles: [],
      split: null,
    }
    const merged = mergeProductSpaces([main])
    expect(merged.some((v) => v.id === "default")).toBe(true)
    expect(merged.filter((v) => v.id.startsWith("space:")).length).toBe(4)
  })

  it("resets a Space to product defaults", () => {
    const built = buildSpaceView(PRODUCT_SPACES[1]!)
    const polluted = {
      ...built,
      tiles: built.tiles.slice(0, 1),
      split: null,
    }
    const reset = resetSpaceView([polluted], "space:observe")
    expect(reset[0]!.tiles.length).toBe(4)
  })
})
