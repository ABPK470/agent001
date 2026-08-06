/**
 * Review master–detail pane ownership + detail in-pane keys.
 * Shared by Trace and Pipelines. Tree row nav stays in resolveReviewTreeKeyboardAction.
 *
 * Detail (same tree metaphor as the left pane — no extra pick chords):
 *   ↑↓ / jk     — scroll
 *   ←→ / hl     — fold / unfold the active accordion (cores)
 *   Space       — toggle active section
 *
 * Trace call tabs: apply falls back to tab-cycle when no sections are registered.
 */

export type ReviewPane = "tree" | "detail"

export type ReviewPaneKeyboardAction =
  | { type: "pane-to-detail" }
  | { type: "pane-to-tree" }
  | { type: "toggle-pane" }
  | { type: "detail-scroll"; delta: number }
  | { type: "detail-scroll-page"; direction: -1 | 1 }
  | { type: "detail-scroll-edge"; edge: "start" | "end" }
  | { type: "section-toggle" }
  | { type: "section-fold"; open: boolean }
  | { type: "none" }

const DETAIL_LINE = 48
const DETAIL_PAGE = 280

export function resolveReviewPaneKeyboardAction(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  focusedPane: ReviewPane,
): ReviewPaneKeyboardAction {
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

  if (key === " " || key === "Spacebar" || event.code === "Space") {
    return { type: "section-toggle" }
  }

  if (key === "ArrowLeft" || key === "h") {
    return { type: "section-fold", open: false }
  }
  if (key === "ArrowRight" || key === "l") {
    return { type: "section-fold", open: true }
  }

  return { type: "none" }
}

export function detailScrollPageDelta(): number {
  return DETAIL_PAGE
}
