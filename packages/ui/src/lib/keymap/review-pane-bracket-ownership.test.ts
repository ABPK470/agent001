/**
 * Behavior: when detail owns the pane, `[` / `]` move sections and never fold-all the tree.
 * When tree owns the pane, `[` / `]` fold-all and never section-move.
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

function dispatchBracketOwnership(opts: {
  focusedPane: "tree" | "detail"
  foldMode: "collapsed" | "expanded"
  onFoldModeChange: (mode: "collapsed" | "expanded") => void
  sections: ReturnType<typeof createDetailSectionController>
  side: "left" | "right"
}) {
  const event = bracketEvent(opts.side)
  const zen = resolveTraceZenKeyboardAction(event, {
    focusedPane: opts.focusedPane,
    viewMode: "tree",
    foldMode: opts.foldMode,
  })
  if (zen.type === "fold-all") opts.onFoldModeChange(zen.mode)

  const pane = resolveReviewPaneKeyboardAction(event, opts.focusedPane, { lateral: "tabs" })
  if (pane.type === "section-move") opts.sections.move(pane.direction)

  return { zen, pane }
}

describe("review pane bracket ownership", () => {
  it("detail pane: ] / [ move sections both ways; never fold-all", () => {
    const onFoldModeChange = vi.fn()
    const sections = createDetailSectionController()
    const ids = ["a", "b", "c"]
    for (const id of ids) {
      sections.register({
        id,
        getOpen: () => true,
        setOpen: () => {},
        headerEl: () => null,
      })
    }

    const down = dispatchBracketOwnership({
      focusedPane: "detail",
      foldMode: "expanded",
      onFoldModeChange,
      sections,
      side: "right",
    })
    expect(down.zen.type).toBe("none")
    expect(down.pane).toEqual({ type: "section-move", direction: 1 })
    expect(onFoldModeChange).not.toHaveBeenCalled()
    expect(sections.getActiveId()).toBe("a")

    const down2 = dispatchBracketOwnership({
      focusedPane: "detail",
      foldMode: "expanded",
      onFoldModeChange,
      sections,
      side: "right",
    })
    expect(down2.zen.type).toBe("none")
    expect(sections.getActiveId()).toBe("b")

    const up = dispatchBracketOwnership({
      focusedPane: "detail",
      foldMode: "expanded",
      onFoldModeChange,
      sections,
      side: "left",
    })
    expect(up.zen.type).toBe("none")
    expect(up.pane).toEqual({ type: "section-move", direction: -1 })
    expect(onFoldModeChange).not.toHaveBeenCalled()
    expect(sections.getActiveId()).toBe("a")
  })

  it("tree pane: [ collapses all and ] expands all; no section move", () => {
    const onFoldModeChange = vi.fn()
    const sections = createDetailSectionController()
    sections.register({
      id: "ghost",
      getOpen: () => true,
      setOpen: () => {},
      headerEl: () => null,
    })

    const collapse = dispatchBracketOwnership({
      focusedPane: "tree",
      foldMode: "expanded",
      onFoldModeChange,
      sections,
      side: "left",
    })
    expect(collapse.zen).toEqual({ type: "fold-all", mode: "collapsed" })
    expect(collapse.pane.type).toBe("none")
    expect(onFoldModeChange).toHaveBeenCalledWith("collapsed")
    expect(sections.getActiveId()).toBeNull()

    onFoldModeChange.mockClear()
    const expand = dispatchBracketOwnership({
      focusedPane: "tree",
      foldMode: "collapsed",
      onFoldModeChange,
      sections,
      side: "right",
    })
    expect(expand.zen).toEqual({ type: "fold-all", mode: "expanded" })
    expect(expand.pane.type).toBe("none")
    expect(onFoldModeChange).toHaveBeenCalledWith("expanded")
    expect(sections.getActiveId()).toBeNull()
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
    const zen = resolveTraceZenKeyboardAction(event, {
      focusedPane: "detail",
      viewMode: "tree",
      foldMode: "expanded",
    })
    expect(zen.type).toBe("none")

    const pane = resolveReviewPaneKeyboardAction(event, "detail", { lateral: "tabs" })
    expect(pane).toEqual({ type: "section-toggle" })
    sections.toggle()
    expect(open).toBe(true)
    sections.toggle()
    expect(open).toBe(false)
  })
})
