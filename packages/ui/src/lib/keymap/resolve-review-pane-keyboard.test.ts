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
  it("moves detail with arrows (not pixel-scroll)", () => {
    expect(resolveReviewPaneKeyboardAction(key({ key: "`" }), "tree")).toEqual({
      type: "toggle-pane",
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "ArrowDown" }), "detail")).toEqual({
      type: "detail-move",
      direction: 1,
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "j" }), "detail")).toEqual({
      type: "detail-move",
      direction: 1,
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "ArrowUp" }), "detail")).toEqual({
      type: "detail-move",
      direction: -1,
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "PageDown" }), "detail")).toEqual({
      type: "detail-scroll-page",
      direction: 1,
    })
  })

  it("folds with ←→ and toggles with Space", () => {
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
  })
})
