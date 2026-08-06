import { describe, expect, it } from "vitest"
import {
  resolveSummonBundleOpen,
  resolveSummonSpaceEnter,
  resolveSummonWidgetEnter,
  resolveSummonWidgetKeep,
} from "./summon-resolve"

describe("summon resolve", () => {
  it("spaces navigate — never peek", () => {
    expect(resolveSummonSpaceEnter("space:observe")).toEqual({
      type: "call-space",
      spaceId: "space:observe",
    })
  })

  it("widgets peek when absent; focus when already on Space", () => {
    expect(resolveSummonWidgetEnter("operation-log", false)).toEqual({
      type: "peek-widget",
      widgetType: "operation-log",
    })
    expect(resolveSummonWidgetEnter("operation-log", true)).toEqual({
      type: "focus-tile",
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

  it("observe core opens Observe with Pipelines focus", () => {
    expect(resolveSummonBundleOpen("bundle:observe-core")).toEqual({
      type: "open-bundle",
      spaceId: "space:observe",
      ensureWidgets: ["operation-log", "live-logs"],
      focusType: "operation-log",
    })
  })

  it("Trace Space navigates (no Agent-debug bundle)", () => {
    expect(resolveSummonSpaceEnter("space:trace")).toEqual({
      type: "call-space",
      spaceId: "space:trace",
    })
  })
})
