import { describe, expect, it } from "vitest"
import {
  filterSummonItems,
  listSummonItems,
  summonActionPreview,
  widgetSummonGroup,
} from "./summon-items"

describe("summon catalog", () => {
  it("orders Spaces → presets → surfaces for the ops board", () => {
    const items = listSummonItems()
    const kinds = items.map((item) => item.kind)
    const firstWidget = kinds.indexOf("widget")
    const lastSpace = kinds.lastIndexOf("space")
    const lastBundle = kinds.lastIndexOf("bundle")
    expect(lastSpace).toBeLessThan(kinds.indexOf("bundle"))
    expect(lastBundle).toBeLessThan(firstWidget)
  })

  it("groups agent surfaces together", () => {
    expect(widgetSummonGroup("debug-inspector")).toBe("agent")
    expect(widgetSummonGroup("operation-log")).toBe("platform")
    expect(widgetSummonGroup("env-sync")).toBe("config")
  })

  it("previews peek vs focus for widgets", () => {
    const widget = listSummonItems().find((item) => item.kind === "widget")!
    expect(summonActionPreview(widget, { onSpace: false, spaceName: "Agent" }).primary).toBe(
      "peek",
    )
    expect(summonActionPreview(widget, { onSpace: true, spaceName: "Agent" }).primary).toBe(
      "focus",
    )
  })

  it("filters across name and kind", () => {
    const items = listSummonItems()
    const hit = filterSummonItems("observe", items)
    expect(hit.some((item) => item.kind === "space" && item.name === "Observe")).toBe(true)
  })
})
