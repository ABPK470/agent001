import { describe, expect, it } from "vitest"
import { summonContextBadge, summonFooterHints } from "./summon-footer"
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
  it("widget shows Enter + Mod+Enter peek", () => {
    const hints = summonFooterHints(widget, { primary: "keep", hasQuery: false })
    expect(hints.map((h) => h.label)).toEqual([
      "keep",
      "peek",
      "move",
      "column",
      "dismiss",
    ])
    expect(hints[1]!.keys).toContain("↵")
  })

  it("space and preset omit Mod+Enter", () => {
    for (const item of [space, preset]) {
      const hints = summonFooterHints(item, { primary: "go", hasQuery: false })
      expect(hints.some((h) => h.label === "peek")).toBe(false)
      expect(hints.map((h) => h.label)).toEqual(["go", "move", "column", "dismiss"])
    }
  })
})

describe("summonContextBadge", () => {
  it("shows keep/peek cue only for widgets", () => {
    expect(summonContextBadge(widget)).toBe("Enter keeps · ⌘Enter peeks")
    expect(summonContextBadge(space)).toBeNull()
    expect(summonContextBadge(null)).toBeNull()
  })
})
