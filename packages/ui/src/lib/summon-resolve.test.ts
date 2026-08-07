import { describe, expect, it } from "vitest"
import {
    resolveSummonBlueprintTileEnter,
    resolveSummonBundleOpen,
    resolveSummonSpaceEnter,
    resolveSummonWidgetEnter,
    resolveSummonWidgetKeep,
    resolveSummonWidgetPeek,
    resolveSummonWidgetsApply,
    resolveSummonWidgetsKeep,
} from "./summon-resolve"

describe("summon resolve", () => {
  it("spaces navigate — never peek", () => {
    expect(resolveSummonSpaceEnter("space:observe")).toEqual({
      type: "call-space",
      spaceId: "space:observe",
    })
  })

  it("custom layouts go-view — not Call Space", () => {
    expect(resolveSummonSpaceEnter("layout-abc")).toEqual({
      type: "go-view",
      viewId: "layout-abc",
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

  it("multi-keep dedupes and focuses the last pick (or explicit focus)", () => {
    expect(resolveSummonWidgetsKeep([])).toBeNull()
    expect(
      resolveSummonWidgetsKeep(["live-logs", "operation-log", "live-logs"]),
    ).toEqual({
      type: "keep-widgets",
      widgets: ["live-logs", "operation-log"],
      focusType: "operation-log",
    })
    expect(
      resolveSummonWidgetsKeep(
        ["live-logs", "operation-log"],
        "live-logs",
      ),
    ).toEqual({
      type: "keep-widgets",
      widgets: ["live-logs", "operation-log"],
      focusType: "live-logs",
    })
  })

  it("apply bag keeps absent and removes present", () => {
    expect(
      resolveSummonWidgetsApply(
        ["live-logs", "operation-log", "bridge"],
        new Set(["operation-log"]),
        "live-logs",
      ),
    ).toEqual({
      type: "apply-widgets",
      keep: ["live-logs", "bridge"],
      remove: ["operation-log"],
      focusType: "live-logs",
    })
  })

  it("blueprint digit on a custom layout uses go-view-focus-pick", () => {
    expect(
      resolveSummonBlueprintTileEnter(
        { kind: "space", id: "layout-xyz", custom: true },
        1,
      ),
    ).toEqual({
      type: "go-view-focus-pick",
      viewId: "layout-xyz",
      pickIndex: 1,
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

  it("blueprint digit focuses a Space leaf", () => {
    expect(
      resolveSummonBlueprintTileEnter(
        { kind: "space", id: "space:reconcile" },
        1,
      ),
    ).toEqual({
      type: "call-space-focus-pick",
      spaceId: "space:reconcile",
      pickIndex: 1,
    })
  })

  it("blueprint digit on preset restores then focuses pick", () => {
    expect(
      resolveSummonBlueprintTileEnter(
        {
          kind: "bundle",
          id: "bundle:observe-core",
          homeSpace: "space:observe",
          focusType: "operation-log",
        },
        1,
      ),
    ).toEqual({
      type: "open-bundle",
      spaceId: "space:observe",
      focusType: "operation-log",
      pickIndex: 1,
    })
  })
})
