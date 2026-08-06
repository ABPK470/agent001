/**
 * Review master–detail pane ownership + detail in-pane keys.
 * Shared by Trace and Pipelines. Tree row nav stays in resolveReviewTreeKeyboardAction.
 *
 * Detail lateral chords:
 *   tabs     — ←→ cycle inspector tabs (Trace call tabs)
 *   sections — ←→ fold/unfold the keyboard-active accordion (tree metaphor)
 *
 * Section pick / toggle (`[` `]` Space) always available in detail when sections register.
 */

export type ReviewPane = "tree" | "detail"

export type DetailLateralMode = "tabs" | "sections"

export type ReviewPaneKeyboardAction =
  | { type: "pane-to-detail" }
  | { type: "pane-to-tree" }
  | { type: "toggle-pane" }
  | { type: "detail-scroll"; delta: number }
  | { type: "detail-scroll-page"; direction: -1 | 1 }
  | { type: "detail-scroll-edge"; edge: "start" | "end" }
  | { type: "cycle-tab"; direction: -1 | 1 }
  | { type: "section-move"; direction: -1 | 1 }
  | { type: "section-toggle" }
  | { type: "section-fold"; open: boolean }
  | { type: "none" }

const DETAIL_LINE = 48
const DETAIL_PAGE = 280

export function resolveReviewPaneKeyboardAction(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  focusedPane: ReviewPane,
  opts: { lateral?: DetailLateralMode } = {},
): ReviewPaneKeyboardAction {
  const lateral = opts.lateral ?? "sections"
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
  if (key === "[" && !event.shiftKey) {
    return { type: "section-move", direction: -1 }
  }
  if (key === "]" && !event.shiftKey) {
    return { type: "section-move", direction: 1 }
  }
  if (key === " " || key === "Spacebar") {
    return { type: "section-toggle" }
  }

  if (key === "ArrowLeft" || key === "h") {
    if (lateral === "tabs") return { type: "cycle-tab", direction: -1 }
    return { type: "section-fold", open: false }
  }
  if (key === "ArrowRight" || key === "l") {
    if (lateral === "tabs") return { type: "cycle-tab", direction: 1 }
    return { type: "section-fold", open: true }
  }

  return { type: "none" }
}

export function detailScrollPageDelta(): number {
  return DETAIL_PAGE
}
