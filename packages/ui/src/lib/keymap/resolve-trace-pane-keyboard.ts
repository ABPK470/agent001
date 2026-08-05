/**
 * Trace pane ownership + detail in-pane keys (Layers 2–3).
 * Tree row nav stays in resolveReviewTreeKeyboardAction when pane === tree.
 */

export type TracePane = "tree" | "detail"

export type TracePaneKeyboardAction =
  | { type: "pane-to-detail" }
  | { type: "pane-to-tree" }
  | { type: "toggle-pane" }
  | { type: "detail-scroll"; delta: number }
  | { type: "detail-scroll-page"; direction: -1 | 1 }
  | { type: "detail-scroll-edge"; edge: "start" | "end" }
  | { type: "cycle-tab"; direction: -1 | 1 }
  | { type: "none" }

const DETAIL_LINE = 48
const DETAIL_PAGE = 280

export function resolveTracePaneKeyboardAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  focusedPane: TracePane,
): TracePaneKeyboardAction {
  const mod = event.metaKey || event.ctrlKey
  if (mod || event.altKey) return { type: "none" }

  const key = event.key

  if (key === "`" && !event.shiftKey) {
    return { type: "toggle-pane" }
  }

  if (focusedPane === "tree") {
    if (key === "Enter") return { type: "pane-to-detail" }
    return { type: "none" }
  }

  // detail pane
  if (key === "ArrowDown" || key === "j") {
    return { type: "detail-scroll", delta: DETAIL_LINE }
  }
  if (key === "ArrowUp" || key === "k") {
    return { type: "detail-scroll", delta: -DETAIL_LINE }
  }
  if (key === "PageDown") {
    return { type: "detail-scroll-page", direction: 1 }
  }
  if (key === "PageUp") {
    return { type: "detail-scroll-page", direction: -1 }
  }
  if (key === "Home") {
    return { type: "detail-scroll-edge", edge: "start" }
  }
  if (key === "End") {
    return { type: "detail-scroll-edge", edge: "end" }
  }
  if (key === "ArrowLeft" || key === "h") {
    return { type: "cycle-tab", direction: -1 }
  }
  if (key === "ArrowRight" || key === "l") {
    return { type: "cycle-tab", direction: 1 }
  }

  return { type: "none" }
}

export function detailScrollPageDelta(): number {
  return DETAIL_PAGE
}
