import { describe, expect, it } from "vitest"
import { firstTileIdForWidgetType } from "./focus-widget-tile"

describe("firstTileIdForWidgetType", () => {
  it("returns the first matching tile id — never a second instance", () => {
    const tiles = [
      { id: "a", type: "debug-inspector" },
      { id: "b", type: "term-chat" },
      { id: "c", type: "debug-inspector" },
    ]
    expect(firstTileIdForWidgetType(tiles, "debug-inspector")).toBe("a")
    expect(firstTileIdForWidgetType(tiles, "term-chat")).toBe("b")
    expect(firstTileIdForWidgetType(tiles, "operation-log")).toBeNull()
  })
})
