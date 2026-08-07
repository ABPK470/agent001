import { describe, expect, it } from "vitest"
import {
    resolveSummonBundleOpen,
    resolveSummonSpaceEnter,
    resolveSummonWidgetEnter,
    resolveSummonWidgetKeep,
    resolveSummonWidgetPeek,
} from "./summon-resolve"

describe("summon resolve", () => {
  it("spaces navigate — never peek", () => {
    expect(resolveSummonSpaceEnter("space:observe")).toEqual({
      type: "call-space",
      spaceId: "space:observe",
    })
  })

  it("Enter keeps when absent; focuses when already on layout", () => {
    expect(resolveSummonWidgetEnter("operation-log", false)).toEqual({
      type: "keep-widgets",
      widgets: ["operation-log"],
      focusType: "operation-log",
    })
    expect(resolveSummonWidgetEnter("operation-log", true)).toEqual({
      type: "focus-tile",
      widgetType: "operation-log",
    })
  })

  it("Trace Enter keeps into current layout — never jumps to Trace Space", () => {
    expect(resolveSummonWidgetEnter("debug-inspector", false)).toEqual({
      type: "keep-widgets",
      widgets: ["debug-inspector"],
      focusType: "debug-inspector",
    })
    expect(resolveSummonWidgetEnter("debug-inspector", true)).toEqual({
      type: "focus-tile",
      widgetType: "debug-inspector",
    })
  })

  it("Mod+Enter peeks", () => {
    expect(resolveSummonWidgetPeek("operation-log")).toEqual({
      type: "peek-widget",
      widgetType: "operation-log",
    })
  })

  it("keep ensures widget without maximize semantics", () => {
    expect(resolveSummonWidgetKeep("debug-inspector")).toEqual({
      type: "keep-widgets",
      widgets: ["debug-inspector"],
      focusType: "debug-inspector",
    })
  })

  it("observe core restores Observe defaults with Pipelines focus", () => {
    expect(resolveSummonBundleOpen("bundle:observe-core")).toEqual({
      type: "open-bundle",
      spaceId: "space:observe",
      focusType: "operation-log",
    })
  })

  it("Trace Space navigates (Go column / Call Space)", () => {
    expect(resolveSummonSpaceEnter("space:trace")).toEqual({
      type: "call-space",
      spaceId: "space:trace",
    })
  })
})
