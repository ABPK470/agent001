import { describe, expect, it } from "vitest"
import { resolveReviewPaneKeyboardAction } from "./resolve-review-pane-keyboard"

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

describe("resolveReviewPaneKeyboardAction", () => {
  it("toggles pane and scrolls detail with arrows only", () => {
    expect(resolveReviewPaneKeyboardAction(key({ key: "`" }), "tree")).toEqual({
      type: "toggle-pane",
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "ArrowDown" }), "detail")).toEqual({
      type: "detail-scroll",
      delta: 48,
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "j" }), "detail")).toEqual({
      type: "detail-scroll",
      delta: 48,
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "ArrowUp" }), "detail")).toEqual({
      type: "detail-scroll",
      delta: -48,
    })
  })

  it("folds with ←→ and toggles with Space — no [ ] pick chords", () => {
    expect(resolveReviewPaneKeyboardAction(key({ key: "ArrowRight" }), "detail")).toEqual({
      type: "section-fold",
      open: true,
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "ArrowLeft" }), "detail")).toEqual({
      type: "section-fold",
      open: false,
    })
    expect(
      resolveReviewPaneKeyboardAction(key({ key: " ", code: "Space" }), "detail"),
    ).toEqual({ type: "section-toggle" })
    expect(
      resolveReviewPaneKeyboardAction(key({ key: "[", code: "BracketLeft" }), "detail"),
    ).toEqual({ type: "none" })
    expect(
      resolveReviewPaneKeyboardAction(key({ key: "]", code: "BracketRight" }), "detail"),
    ).toEqual({ type: "none" })
  })
})
