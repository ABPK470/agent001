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
  const tree = {
    focusedPane: "tree" as const,
    viewMode: "tree" as const,
    foldMode: "expanded" as const,
  }

  it("fold-all only while the tree pane owns keys", () => {
    expect(
      resolveTraceZenKeyboardAction(key({ key: "[", code: "BracketLeft" }), tree),
    ).toEqual({ type: "fold-all", mode: "collapsed" })
    expect(
      resolveTraceZenKeyboardAction(key({ key: "]", code: "BracketRight" }), {
        ...tree,
        foldMode: "collapsed",
      }),
    ).toEqual({ type: "fold-all", mode: "expanded" })
  })

  it("never fold-alls when the detail pane owns keys", () => {
    const detail = { ...tree, focusedPane: "detail" as const }
    expect(
      resolveTraceZenKeyboardAction(key({ key: "[", code: "BracketLeft" }), detail),
    ).toEqual({ type: "none" })
    expect(
      resolveTraceZenKeyboardAction(key({ key: "]", code: "BracketRight" }), detail),
    ).toEqual({ type: "none" })
    expect(
      resolveTraceZenKeyboardAction(key({ key: "t", code: "KeyT" }), detail),
    ).toEqual({ type: "none" })
  })
})
