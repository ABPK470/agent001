import { describe, expect, it } from "vitest"
import { buildSpaceView, PRODUCT_SPACES } from "../../lib/spaces"
import { leafNode } from "../../lib/split-tree"
import { listSummonItems } from "./summon-items"
import {
  cycleSummonFilter,
  filterSummonByMode,
  moveSummonListSelection,
  orderSummonForNav,
  shouldSummonBlueprintDigit,
  shouldSummonFilterArrow,
  SUMMON_FILTER_MODES,
  summonActionKeys,
  summonListSections,
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

describe("summon list navigation", () => {
  it("orders filter tabs All → Spaces → Surfaces", () => {
    expect([...SUMMON_FILTER_MODES]).toEqual(["all", "spaces", "surfaces"])
  })

  it("orders destinations before surfaces", () => {
    const ordered = orderSummonForNav(catalogWithObserveDrift())
    const firstWidget = ordered.findIndex((item) => item.kind === "widget")
    expect(ordered.slice(0, firstWidget).every((item) => item.kind !== "widget")).toBe(true)
  })

  it("filters All / Spaces / Surfaces", () => {
    const items = catalogWithObserveDrift()
    expect(filterSummonByMode(items, "spaces").every((i) => i.kind !== "widget")).toBe(true)
    expect(filterSummonByMode(items, "surfaces").every((i) => i.kind === "widget")).toBe(true)
    expect(filterSummonByMode(items, "all").length).toBe(items.length)
  })

  it("sections Spaces → Presets → Surfaces", () => {
    const sections = summonListSections(filterSummonByMode(catalogWithObserveDrift(), "all"))
    expect(sections.map((s) => s.id)).toEqual(["spaces", "presets", "surfaces"])
  })

  it("moves ↑↓ in a flat list", () => {
    expect(moveSummonListSelection(0, 5, "down")).toBe(1)
    expect(moveSummonListSelection(0, 5, "up")).toBe(0)
    expect(moveSummonListSelection(4, 5, "down")).toBe(4)
  })

  it("←→ / Tab cycle All → Spaces → Surfaces", () => {
    expect(cycleSummonFilter("all", "next")).toBe("spaces")
    expect(cycleSummonFilter("spaces", "next")).toBe("surfaces")
    expect(cycleSummonFilter("surfaces", "next")).toBe("all")
    expect(cycleSummonFilter("all", "prev")).toBe("surfaces")
  })

  it("filter arrows only when query empty", () => {
    expect(
      shouldSummonFilterArrow(
        { key: "ArrowRight", metaKey: false, ctrlKey: false, altKey: false },
        "",
      ),
    ).toBe("next")
    expect(
      shouldSummonFilterArrow(
        { key: "ArrowLeft", metaKey: false, ctrlKey: false, altKey: false },
        "pipe",
      ),
    ).toBeNull()
  })

  it("exposes action keys for Call Space 1–5 only", () => {
    const observe = catalogWithObserveDrift().find(
      (item) => item.kind === "space" && item.index === 2,
    )!
    expect(summonActionKeys(observe, { onSpace: false })).toEqual([
      expect.stringMatching(/^(⌘|Ctrl)$/),
      "2",
    ])
    const users = catalogWithObserveDrift().find(
      (item) => item.kind === "space" && item.id === "space:users",
    )!
    expect(summonActionKeys(users, { onSpace: false })).toEqual(["↵"])
  })

  it("digit tile guard respects query and modifiers", () => {
    const base = {
      key: "2",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }
    expect(shouldSummonBlueprintDigit(base, "", 3)).toBe(1)
    expect(shouldSummonBlueprintDigit(base, "sync", 3)).toBeNull()
    expect(shouldSummonBlueprintDigit({ ...base, metaKey: true }, "", 3)).toBeNull()
    expect(shouldSummonBlueprintDigit({ ...base, key: "9" }, "", 2)).toBeNull()
  })
})
