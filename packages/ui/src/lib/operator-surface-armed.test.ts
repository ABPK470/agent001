import { describe, expect, it } from "vitest"
import {
  isOperatorSurfaceArmed,
  isPeekWidgetInstance,
  peekWidgetInstanceId,
} from "./operator-surface-armed"

const tile = {
  widgetId: "tile-1",
  viewId: "view-a",
  type: "live-logs" as const,
}

const peek = {
  widgetId: peekWidgetInstanceId("live-logs"),
  viewId: "view-a",
  type: "live-logs" as const,
}

describe("operator surface armed", () => {
  it("names peek instances with a stable prefix", () => {
    expect(peekWidgetInstanceId("live-logs")).toBe("peek:live-logs")
    expect(isPeekWidgetInstance(peek)).toBe(true)
    expect(isPeekWidgetInstance(tile)).toBe(false)
  })

  it("arms a focused tile when the session is clear", () => {
    expect(
      isOperatorSurfaceArmed({
        instance: tile,
        focusedTileId: "tile-1",
        modalWidgetType: null,
        summonOpen: false,
        keymapSheetOpen: false,
      }),
    ).toBe(true)
  })

  it("stays quiet for tiles while Summon is open", () => {
    expect(
      isOperatorSurfaceArmed({
        instance: tile,
        focusedTileId: "tile-1",
        modalWidgetType: null,
        summonOpen: true,
        keymapSheetOpen: false,
      }),
    ).toBe(false)
  })

  it("arms the peek mount of the peeked type (Summon may stay open)", () => {
    expect(
      isOperatorSurfaceArmed({
        instance: peek,
        focusedTileId: "tile-1",
        modalWidgetType: "live-logs",
        summonOpen: true,
        keymapSheetOpen: false,
      }),
    ).toBe(true)
  })

  it("does not arm a tile of the peeked type — peek owns the surface", () => {
    expect(
      isOperatorSurfaceArmed({
        instance: tile,
        focusedTileId: "tile-1",
        modalWidgetType: "live-logs",
        summonOpen: true,
        keymapSheetOpen: false,
      }),
    ).toBe(false)
  })

  it("does not arm a peek of a different type", () => {
    expect(
      isOperatorSurfaceArmed({
        instance: { ...peek, type: "operation-log", widgetId: peekWidgetInstanceId("operation-log") },
        focusedTileId: null,
        modalWidgetType: "live-logs",
        summonOpen: true,
        keymapSheetOpen: false,
      }),
    ).toBe(false)
  })

  it("layout focus (zen/solo) arms when no overlay owns the session", () => {
    expect(
      isOperatorSurfaceArmed({
        instance: tile,
        focusedTileId: null,
        modalWidgetType: null,
        summonOpen: false,
        keymapSheetOpen: false,
        layoutFocus: true,
      }),
    ).toBe(true)
    expect(
      isOperatorSurfaceArmed({
        instance: tile,
        focusedTileId: null,
        modalWidgetType: null,
        summonOpen: true,
        keymapSheetOpen: false,
        layoutFocus: true,
      }),
    ).toBe(false)
  })
})
