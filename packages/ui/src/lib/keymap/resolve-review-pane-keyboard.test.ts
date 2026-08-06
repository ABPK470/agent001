import { describe, expect, it } from "vitest"
import { resolveReviewPaneKeyboardAction } from "./resolve-review-pane-keyboard"

function key(
  partial: Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">,
): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  }
}

describe("resolveReviewPaneKeyboardAction", () => {
  it("toggles pane and scrolls detail", () => {
    expect(resolveReviewPaneKeyboardAction(key({ key: "`" }), "tree")).toEqual({
      type: "toggle-pane",
    })
    expect(resolveReviewPaneKeyboardAction(key({ key: "j" }), "detail")).toEqual({
      type: "detail-scroll",
      delta: 48,
    })
  })

  it("uses section lateral fold and pick keys", () => {
    expect(
      resolveReviewPaneKeyboardAction(key({ key: "ArrowRight" }), "detail", {
        lateral: "sections",
      }),
    ).toEqual({ type: "section-fold", open: true })
    expect(
      resolveReviewPaneKeyboardAction(key({ key: "[" }), "detail", { lateral: "sections" }),
    ).toEqual({ type: "section-move", direction: -1 })
    expect(
      resolveReviewPaneKeyboardAction(key({ key: " " }), "detail", { lateral: "sections" }),
    ).toEqual({ type: "section-toggle" })
  })

  it("uses tab cycle when lateral is tabs", () => {
    expect(
      resolveReviewPaneKeyboardAction(key({ key: "ArrowRight" }), "detail", { lateral: "tabs" }),
    ).toEqual({ type: "cycle-tab", direction: 1 })
    expect(
      resolveReviewPaneKeyboardAction(key({ key: "]" }), "detail", { lateral: "tabs" }),
    ).toEqual({ type: "section-move", direction: 1 })
  })
})
