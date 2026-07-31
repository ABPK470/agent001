import { describe, expect, it } from "vitest"
import { WIDGET_DEFAULTS } from "../lib/widget-layout-defaults"
import { pruneUnknownWidgets } from "./layout-store"

describe("pruneUnknownWidgets", () => {
  it("drops removed catalog types from saved layouts", () => {
    const views = pruneUnknownWidgets([
      {
        id: "v1",
        name: "Main",
        widgets: [
          { id: "keep", type: "term-chat" },
          { id: "gone-a", type: "agent-chat" as never },
          { id: "gone-b", type: "step-timeline" as never },
          { id: "gone-c", type: "run-history" as never },
          { id: "status", type: "run-status" },
        ],
        layouts: {
          lg: [
            { i: "keep", x: 0, y: 0, w: 6, h: 8 },
            { i: "gone-a", x: 6, y: 0, w: 6, h: 8 },
            { i: "status", x: 0, y: 8, w: 12, h: 8 },
          ],
        },
        split: null,
      },
    ])

    expect(views[0]!.widgets.map((w) => w.id)).toEqual(["keep", "status"])
    expect(views[0]!.layouts["lg"]?.map((l) => l.i)).toEqual(["keep", "status"])
    expect("agent-chat" in WIDGET_DEFAULTS).toBe(false)
    expect("run-status" in WIDGET_DEFAULTS).toBe(true)
  })
})
