/**
 * Trace pane keyboard — thin alias over shared review pane resolver (tabs lateral).
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
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  focusedPane: TracePane,
): TracePaneKeyboardAction {
  return resolveReviewPaneKeyboardAction(event, focusedPane, { lateral: "tabs" })
}

export { detailScrollPageDelta }
