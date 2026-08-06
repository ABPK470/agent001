import { describe, expect, it } from "vitest"
import { listSummonItems } from "./summon-items"
import {
  moveSummonSelection,
  orderSummonForNav,
  partitionSummonColumns,
  summonActionKeys,
} from "./summon-tabs"

describe("summon board navigation", () => {
  it("partitions Go vs Surface without collapsing the board", () => {
    const columns = partitionSummonColumns(listSummonItems())
    expect(columns.go.every((item) => item.kind === "space" || item.kind === "bundle")).toBe(
      true,
    )
    expect(columns.surface.every((item) => item.kind === "widget")).toBe(true)
    expect(columns.go.length).toBeGreaterThan(0)
    expect(columns.surface.length).toBeGreaterThan(0)
  })

  it("orders nav destinations before surfaces", () => {
    const ordered = orderSummonForNav(listSummonItems())
    const firstWidget = ordered.findIndex((item) => item.kind === "widget")
    expect(ordered.slice(0, firstWidget).every((item) => item.kind !== "widget")).toBe(true)
  })

  it("moves ↑↓ inside a column and ←→ across columns", () => {
    const columns = {
      go: listSummonItems().filter((item) => item.kind !== "widget").slice(0, 3),
      surface: listSummonItems().filter((item) => item.kind === "widget").slice(0, 4),
    }
    expect(moveSummonSelection(0, columns, "down")).toBe(1)
    expect(moveSummonSelection(0, columns, "up")).toBe(0)
    expect(moveSummonSelection(0, columns, "right")).toBe(3)
    expect(moveSummonSelection(3, columns, "left")).toBe(0)
    expect(moveSummonSelection(2, columns, "down")).toBe(2)
    expect(moveSummonSelection(2, columns, "right")).toBe(3 + 2)
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
