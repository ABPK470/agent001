import { describe, expect, it } from "vitest"
import {
  summonApplyLabel,
  summonContextHints,
  summonFooterHints,
} from "./summon-footer"
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

describe("summonApplyLabel", () => {
  it("names keep / remove / apply mixes", () => {
    expect(summonApplyLabel({ keepCount: 2, removeCount: 0 })).toBe("keep 2")
    expect(summonApplyLabel({ keepCount: 0, removeCount: 3 })).toBe("remove 3")
    expect(summonApplyLabel({ keepCount: 1, removeCount: 2 })).toBe("apply 3")
  })
})

describe("summonFooterHints", () => {
  it("widget shows Enter + Space stage + Mod+Enter peek", () => {
    const hints = summonFooterHints(widget, { primary: "keep", hasQuery: false })
    expect(hints.map((h) => h.label)).toEqual([
      "keep",
      "stage",
      "peek",
      "move",
      "filter",
      "cycle",
      "dismiss",
    ])
    expect(hints.find((h) => h.label === "stage")?.keys).toEqual(["Space"])
  })

  it("staged bag changes Enter / Esc and hides peek + tile digits", () => {
    const hints = summonFooterHints(widget, {
      primary: "keep",
      hasQuery: false,
      pickableCount: 3,
      keepCount: 1,
      removeCount: 1,
    })
    expect(hints.map((h) => h.label)).toEqual([
      "apply 2",
      "stage",
      "move",
      "filter",
      "cycle",
      "clear bag",
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

  it("staged bag shows stage + apply label even without a widget cursor", () => {
    expect(
      summonContextHints(null, { keepCount: 0, removeCount: 3 })?.map((h) => h.label),
    ).toEqual(["stage", "remove 3"])
  })
})
