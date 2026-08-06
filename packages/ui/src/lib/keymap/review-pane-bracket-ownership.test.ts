/**
 * Bare `[` / `]` never fold-all and never pick detail sections.
 * Fold-all is toolbar-only; detail uses ←→ / Space; Mod+[ ] is view tabs.
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
  it("detail pane: bare brackets are inert; zen never fold-alls", () => {
    const right = bracketEvent("right")
    expect(resolveTraceZenKeyboardAction(right, { focusedPane: "detail" }).type).toBe("none")
    expect(resolveReviewPaneKeyboardAction(right, "detail").type).toBe("none")

    const left = bracketEvent("left")
    expect(resolveTraceZenKeyboardAction(left, { focusedPane: "detail" }).type).toBe("none")
    expect(resolveReviewPaneKeyboardAction(left, "detail").type).toBe("none")
  })

  it("tree pane: bare brackets do nothing (no fold-all)", () => {
    const onFold = vi.fn()
    const left = bracketEvent("left")
    expect(resolveTraceZenKeyboardAction(left, { focusedPane: "tree" }).type).toBe("none")
    expect(resolveReviewPaneKeyboardAction(left, "tree").type).toBe("none")
    expect(onFold).not.toHaveBeenCalled()
  })

  it("detail Space toggles; ←→ folds; activate picks the target core", () => {
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

    expect(sections.activate("s1")).toBe(true)
    expect(sections.getActiveId()).toBe("s1")

    expect(
      resolveReviewPaneKeyboardAction(
        { key: " ", code: "Space", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
        "detail",
      ),
    ).toEqual({ type: "section-toggle" })
    sections.toggle()
    expect(open).toBe(true)

    expect(
      resolveReviewPaneKeyboardAction(
        {
          key: "ArrowLeft",
          code: "ArrowLeft",
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        "detail",
      ),
    ).toEqual({ type: "section-fold", open: false })
  })
})
