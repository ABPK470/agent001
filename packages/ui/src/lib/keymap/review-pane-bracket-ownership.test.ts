/**
 * Behavior: bare `[` / `]` never fold-all. On detail they move sections;
 * on tree they are inert (fold-all is toolbar-only).
 */

import { describe, expect, it, vi } from "vitest"
import { createDetailSectionController } from "../review/detail-section-controller"
import { resolveReviewPaneKeyboardAction } from "./resolve-review-pane-keyboard"
import { resolveTraceZenKeyboardAction } from "./resolve-trace-zen-keyboard"

function bracketEvent(side: "left" | "right") {
  return {
    key: side === "left" ? "[" : "]",
    code: side === "left" ? "BracketLeft" : "BracketRight",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  } as const
}

describe("review pane bracket ownership", () => {
  it("detail pane: ] / [ move sections both ways; zen never fold-alls", () => {
    const sections = createDetailSectionController()
    for (const id of ["a", "b", "c"]) {
      sections.register({
        id,
        getOpen: () => true,
        setOpen: () => {},
        headerEl: () => null,
      })
    }

    const right = bracketEvent("right")
    expect(resolveTraceZenKeyboardAction(right, { focusedPane: "detail" }).type).toBe("none")
    expect(resolveReviewPaneKeyboardAction(right, "detail", { lateral: "tabs" })).toEqual({
      type: "section-move",
      direction: 1,
    })
    sections.move(1)
    expect(sections.getActiveId()).toBe("a")
    sections.move(1)
    expect(sections.getActiveId()).toBe("b")

    const left = bracketEvent("left")
    expect(resolveTraceZenKeyboardAction(left, { focusedPane: "detail" }).type).toBe("none")
    expect(resolveReviewPaneKeyboardAction(left, "detail", { lateral: "tabs" })).toEqual({
      type: "section-move",
      direction: -1,
    })
    sections.move(-1)
    expect(sections.getActiveId()).toBe("a")
  })

  it("tree pane: bare brackets do nothing (no fold-all, no section move)", () => {
    const onFold = vi.fn()
    const left = bracketEvent("left")
    const zen = resolveTraceZenKeyboardAction(left, { focusedPane: "tree" })
    const pane = resolveReviewPaneKeyboardAction(left, "tree", { lateral: "tabs" })
    expect(zen.type).toBe("none")
    expect(pane.type).toBe("none")
    expect(onFold).not.toHaveBeenCalled()
  })

  it("detail Space toggles the active section", () => {
    let open = false
    const sections = createDetailSectionController()
    sections.register({
      id: "s1",
      getOpen: () => open,
      setOpen: (next) => {
        open = next
      },
      headerEl: () => null,
    })

    const event = {
      key: " ",
      code: "Space",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    }
    expect(resolveTraceZenKeyboardAction(event, { focusedPane: "detail" }).type).toBe("none")
    expect(resolveReviewPaneKeyboardAction(event, "detail", { lateral: "tabs" })).toEqual({
      type: "section-toggle",
    })
    sections.toggle()
    expect(open).toBe(true)
  })
})
