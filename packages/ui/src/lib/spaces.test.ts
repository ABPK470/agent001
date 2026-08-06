import { describe, expect, it } from "vitest"
import { COLS } from "./grid-math"
import { layoutLeaves, canvasBounds } from "./split-tree"
import {
  PRODUCT_SPACES,
  SPACE_LAYOUT_VERSION,
  buildSpaceView,
  isProductSpaceAtDefault,
  mergeProductSpaces,
  migrateProductSpaceViews,
  reapplyProductSpaceLayouts,
  resetSpaceView,
  spaceByIndex,
} from "./spaces"
import { leafNode } from "./split-tree"

function leafRatio(
  view: ReturnType<typeof buildSpaceView>,
  type: string,
  axis: "w" | "h",
): number {
  const tile = view.tiles.find((t) => t.type === type)
  expect(tile).toBeTruthy()
  const leaves = layoutLeaves(view.split, canvasBounds(COLS, 24))
  const leaf = leaves.find((l) => l.tileId === tile!.id)
  expect(leaf).toBeTruthy()
  const total = axis === "w" ? COLS : 24
  return leaf!.rect[axis] / total
}

describe("product spaces", () => {
  it("exposes four Call Space indices", () => {
    expect(PRODUCT_SPACES.filter((s) => s.index >= 1).map((s) => s.index)).toEqual([
      1, 2, 3, 4,
    ])
    expect(spaceByIndex(2)?.id).toBe("space:observe")
    expect(spaceByIndex(0)).toBeUndefined()
  })

  it("Observe is Pipelines 70% | Event stream 30%", () => {
    const view = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:observe")!)
    expect(view.tiles.map((t) => t.type)).toEqual(["operation-log", "live-logs"])
    expect(leafRatio(view, "operation-log", "w")).toBeCloseTo(0.7, 2)
    expect(leafRatio(view, "live-logs", "w")).toBeCloseTo(0.3, 2)
  })

  it("Trace Space is Trace alone", () => {
    const view = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:trace")!)
    expect(view.name).toBe("Trace")
    expect(view.tiles.map((t) => t.type)).toEqual(["debug-inspector"])
    expect(view.split?.kind).toBe("leaf")
  })

  it("migrates legacy space:debug to space:trace", () => {
    expect(
      migrateProductSpaceViews([
        { id: "space:debug", name: "Debug", tiles: [], split: null },
      ]),
    ).toEqual([{ id: "space:trace", name: "Trace", tiles: [], split: null }])
  })

  it("Reconcile is Sync | Entity registry 50/50", () => {
    const view = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:reconcile")!)
    expect(leafRatio(view, "env-sync", "w")).toBeCloseTo(0.5, 2)
    expect(leafRatio(view, "entity-registry", "w")).toBeCloseTo(0.5, 2)
  })

  it("Agent is Trace 60% | Chat 40% (no Threads tile)", () => {
    const view = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:agent")!)
    expect(view.tiles.map((t) => t.type)).toEqual(["debug-inspector", "term-chat"])
    expect(leafRatio(view, "debug-inspector", "w")).toBeCloseTo(0.6, 2)
    expect(leafRatio(view, "term-chat", "w")).toBeCloseTo(0.4, 2)
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
    expect(merged.filter((v) => v.id.startsWith("space:")).length).toBe(PRODUCT_SPACES.length)
  })

  it("reapply rebuilds product Spaces and keeps DIY views", () => {
    const main = {
      id: "default",
      name: "Main",
      tiles: [],
      split: null,
    }
    const polluted = {
      ...buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:observe")!),
      tiles: [],
      split: null,
    }
    const next = reapplyProductSpaceLayouts([main, polluted])
    expect(next.some((v) => v.id === "default")).toBe(true)
    const observe = next.find((v) => v.id === "space:observe")
    expect(observe?.tiles.map((t) => t.type)).toEqual(["operation-log", "live-logs"])
  })

  it("resets a Space to product defaults", () => {
    const built = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:observe")!)
    const polluted = {
      ...built,
      tiles: built.tiles.slice(0, 1),
      split: null,
    }
    const reset = resetSpaceView([polluted], "space:observe")
    expect(reset[0]!.tiles.length).toBe(2)
  })

  it("exports a layout version for persistence migration", () => {
    expect(SPACE_LAYOUT_VERSION).toBeGreaterThanOrEqual(5)
  })

  it("isProductSpaceAtDefault is true for a fresh Space and false when changed", () => {
    const observe = buildSpaceView(PRODUCT_SPACES.find((s) => s.id === "space:observe")!)
    expect(isProductSpaceAtDefault(observe)).toBe(true)

    const ratioDrift = {
      ...observe,
      split:
        observe.split?.kind === "split"
          ? { ...observe.split, ratio: 0.55 }
          : observe.split,
    }
    expect(isProductSpaceAtDefault(ratioDrift)).toBe(false)

    const missingTile = {
      ...observe,
      tiles: observe.tiles.slice(0, 1),
      split: leafNode(observe.tiles[0]!.id),
    }
    expect(isProductSpaceAtDefault(missingTile)).toBe(false)

    expect(
      isProductSpaceAtDefault({
        id: "diy",
        name: "Mine",
        tiles: [],
        split: null,
      }),
    ).toBe(false)
  })
})
