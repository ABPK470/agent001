import { describe, expect, it } from "vitest"
import { resolveTracePaneKeyboardAction } from "./resolve-trace-pane-keyboard"

function key(
  partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">,
): Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    code: "",
    ...partial,
  }
}

describe("resolveTracePaneKeyboardAction", () => {
  it("enters detail from tree on Enter", () => {
    expect(resolveTracePaneKeyboardAction(key({ key: "Enter" }), "tree")).toEqual({
      type: "pane-to-detail",
    })
  })

  it("toggles pane on backtick", () => {
    expect(resolveTracePaneKeyboardAction(key({ key: "`" }), "tree")).toEqual({
      type: "toggle-pane",
    })
    expect(resolveTracePaneKeyboardAction(key({ key: "`" }), "detail")).toEqual({
      type: "toggle-pane",
    })
  })

  it("scrolls and folds in detail — brackets are inert", () => {
    expect(resolveTracePaneKeyboardAction(key({ key: "j" }), "detail")).toEqual({
      type: "detail-scroll",
      delta: 48,
    })
    expect(resolveTracePaneKeyboardAction(key({ key: "ArrowRight" }), "detail")).toEqual({
      type: "section-fold",
      open: true,
    })
    expect(
      resolveTracePaneKeyboardAction(key({ key: "]", code: "BracketRight" }), "detail"),
    ).toEqual({ type: "none" })
    expect(resolveTracePaneKeyboardAction(key({ key: "j" }), "tree")).toEqual({ type: "none" })
  })
})
