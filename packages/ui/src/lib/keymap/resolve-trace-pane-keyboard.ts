/**
 * Trace pane keyboard — thin alias over shared review pane resolver.
 * Detail ←→ folds sections (call tabs are an apply fallback when none registered).
 */

import {
  detailScrollPageDelta,
  resolveReviewPaneKeyboardAction,
  type ReviewPane,
  type ReviewPaneKeyboardAction,
} from "./resolve-review-pane-keyboard"

export type TracePane = ReviewPane
export type TracePaneKeyboardAction = ReviewPaneKeyboardAction

export function resolveTracePaneKeyboardAction(
  event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  focusedPane: TracePane,
): TracePaneKeyboardAction {
  return resolveReviewPaneKeyboardAction(event, focusedPane)
}

export { detailScrollPageDelta }
