import { describe, expect, it } from "vitest"
import { listSummonItems } from "./summon-items"
import {
  filterSummonByTab,
  nextSummonTab,
  orderSummonForNav,
  summonActionKeys,
  summonTabFromDigit,
} from "./summon-tabs"

describe("summon tabs", () => {
  it("filters Go vs Surface", () => {
    const items = listSummonItems()
    const go = filterSummonByTab(items, "go")
    expect(go.every((item) => item.kind === "space" || item.kind === "bundle")).toBe(true)
    const surfaces = filterSummonByTab(items, "surface")
    expect(surfaces.every((item) => item.kind === "widget")).toBe(true)
  })

  it("cycles tabs and maps digits", () => {
    expect(nextSummonTab("all", 1)).toBe("go")
    expect(nextSummonTab("surface", 1)).toBe("all")
    expect(summonTabFromDigit("3")).toBe("surface")
  })

  it("orders nav destinations before surfaces", () => {
    const ordered = orderSummonForNav(listSummonItems())
    const firstWidget = ordered.findIndex((item) => item.kind === "widget")
    expect(ordered.slice(0, firstWidget).every((item) => item.kind !== "widget")).toBe(true)
  })

  it("exposes action keys for spaces", () => {
    const observe = listSummonItems().find(
      (item) => item.kind === "space" && item.index === 2,
    )!
    expect(summonActionKeys(observe, { onSpace: false })).toEqual([
      expect.stringMatching(/^(⌘|Ctrl)$/),
      "2",
    ])
  })
})
