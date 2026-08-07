import { describe, expect, it } from "vitest"
import { summonContextHints, summonFooterHints } from "./summon-footer"
import type { SummonItem } from "./summon-items"

const space: SummonItem = {
  kind: "space",
  id: "space:observe",
  name: "Observe",
  desc: "Pipelines",
  index: 2,
}

const preset: SummonItem = {
  kind: "bundle",
  id: "bundle:observe-core",
  name: "Observe",
  desc: "Default",
  homeSpace: "space:observe",
  focusType: "operation-log",
}

const widget: SummonItem = {
  kind: "widget",
  type: "operation-log",
  name: "Pipelines",
  desc: "Ops",
  group: "platform",
}

describe("summonFooterHints", () => {
  it("widget shows Enter + Mod+Enter peek + filter chords", () => {
    const hints = summonFooterHints(widget, { primary: "keep", hasQuery: false })
    expect(hints.map((h) => h.label)).toEqual([
      "keep",
      "peek",
      "move",
      "filter",
      "cycle",
      "dismiss",
    ])
  })

  it("blueprint with 2+ tiles adds digit hint when query empty", () => {
    const hints = summonFooterHints(space, {
      primary: "go",
      hasQuery: false,
      pickableCount: 2,
    })
    expect(hints.map((h) => h.label)).toContain("tile")
    expect(hints.some((h) => h.keys[0] === "1–2")).toBe(true)
  })

  it("space and preset omit Mod+Enter", () => {
    for (const item of [space, preset]) {
      const hints = summonFooterHints(item, { primary: "go", hasQuery: false })
      expect(hints.some((h) => h.label === "peek")).toBe(false)
      expect(hints.map((h) => h.label)).toEqual([
        "go",
        "move",
        "filter",
        "cycle",
        "dismiss",
      ])
    }
  })
})

describe("summonContextHints", () => {
  it("shows keep/peek kbd chips only for widgets", () => {
    expect(summonContextHints(widget)?.map((h) => h.label)).toEqual(["keeps", "peeks"])
    expect(summonContextHints(space)).toBeNull()
    expect(summonContextHints(null)).toBeNull()
  })
})
