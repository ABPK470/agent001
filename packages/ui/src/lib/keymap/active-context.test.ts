import { describe, expect, it } from "vitest"
import { resolveKeymapActiveContext } from "./active-context"

describe("keymap active context", () => {
  it("builds Trace pane override banner", () => {
    expect(
      resolveKeymapActiveContext({
        spaceName: "Agent",
        widgetLabel: "Trace",
        maximized: false,
        zen: false,
        tracePane: "detail",
      }),
    ).toEqual({
      title: "Agent · Trace · Detail pane",
      override: true,
    })
  })

  it("falls back to workspace when nothing focused", () => {
    expect(
      resolveKeymapActiveContext({
        spaceName: null,
        widgetLabel: null,
        maximized: false,
        zen: false,
        tracePane: null,
      }),
    ).toEqual({ title: "Workspace", override: false })
  })
})
