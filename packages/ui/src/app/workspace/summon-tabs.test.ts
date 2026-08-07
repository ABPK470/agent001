import { describe, expect, it } from "vitest"
import { buildSpaceView, PRODUCT_SPACES } from "../../lib/spaces"
import { leafNode } from "../../lib/split-tree"
import { listSummonItems } from "./summon-items"
import {
  moveSummonSelection,
  orderSummonForNav,
  partitionSummonColumns,
  summonActionKeys,
} from "./summon-tabs"

function catalogWithObserveDrift() {
  const views = PRODUCT_SPACES.map((def) => {
    const view = buildSpaceView(def)
    if (def.id !== "space:observe") return view
    return {
      ...view,
      tiles: view.tiles.slice(0, 1),
      split: leafNode(view.tiles[0]!.id),
    }
  })
  return listSummonItems({ views })
}

describe("summon board navigation", () => {
  it("partitions Go vs Surface without collapsing the board", () => {
    const columns = partitionSummonColumns(catalogWithObserveDrift())
    expect(columns.go.every((item) => item.kind === "space" || item.kind === "bundle")).toBe(
      true,
    )
    expect(columns.surface.every((item) => item.kind === "widget")).toBe(true)
    expect(columns.go.length).toBeGreaterThan(0)
    expect(columns.surface.length).toBeGreaterThan(0)
  })

  it("orders nav destinations before surfaces", () => {
    const ordered = orderSummonForNav(catalogWithObserveDrift())
    const firstWidget = ordered.findIndex((item) => item.kind === "widget")
    expect(ordered.slice(0, firstWidget).every((item) => item.kind !== "widget")).toBe(true)
  })

  it("moves ↑↓ inside a column and ←→ across columns", () => {
    const items = catalogWithObserveDrift()
    const columns = {
      go: items.filter((item) => item.kind !== "widget").slice(0, 3),
      surface: items.filter((item) => item.kind === "widget").slice(0, 4),
    }
    expect(moveSummonSelection(0, columns, "down")).toBe(1)
    expect(moveSummonSelection(0, columns, "up")).toBe(0)
    expect(moveSummonSelection(0, columns, "right")).toBe(3)
    expect(moveSummonSelection(3, columns, "left")).toBe(0)
    expect(moveSummonSelection(2, columns, "down")).toBe(2)
    expect(moveSummonSelection(2, columns, "right")).toBe(3 + 2)
  })

  it("exposes action keys for spaces", () => {
    const observe = catalogWithObserveDrift().find(
      (item) => item.kind === "space" && item.index === 2,
    )!
    expect(summonActionKeys(observe, { onSpace: false })).toEqual([
      expect.stringMatching(/^(⌘|Ctrl)$/),
      "2",
    ])
  })
})
