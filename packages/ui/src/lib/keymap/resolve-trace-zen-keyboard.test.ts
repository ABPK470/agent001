import { describe, expect, it } from "vitest"
import { resolveTraceZenKeyboardAction } from "./resolve-trace-zen-keyboard"

function key(
  partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key" | "code">,
): Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey"> {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  }
}

describe("resolveTraceZenKeyboardAction", () => {
  it("never fold-alls on bare brackets (detail owns [ ])", () => {
    expect(
      resolveTraceZenKeyboardAction(key({ key: "[", code: "BracketLeft" }), {
        focusedPane: "tree",
      }),
    ).toEqual({ type: "none" })
    expect(
      resolveTraceZenKeyboardAction(key({ key: "]", code: "BracketRight" }), {
        focusedPane: "detail",
      }),
    ).toEqual({ type: "none" })
  })

  it("switches Tree/Waterfall only on the tree pane", () => {
    expect(
      resolveTraceZenKeyboardAction(key({ key: "t", code: "KeyT" }), { focusedPane: "tree" }),
    ).toEqual({ type: "view-tree" })
    expect(
      resolveTraceZenKeyboardAction(key({ key: "w", code: "KeyW" }), { focusedPane: "detail" }),
    ).toEqual({ type: "none" })
  })

  it("opens filter from either pane", () => {
    expect(
      resolveTraceZenKeyboardAction(key({ key: "/", code: "Slash" }), { focusedPane: "detail" }),
    ).toEqual({ type: "open-filter" })
  })
})
