/**
 * Trace zen / tile chords that are NOT pane-owned (filter, view mode, fold-all).
 * Fold-all `[` `]` is tree-pane only — detail owns those keys for sections.
 */

import { resolveBracketDirection } from "./bracket-keys"
import type { ReviewPane } from "./resolve-review-pane-keyboard"

export type TraceZenKeyboardAction =
  | { type: "open-filter" }
  | { type: "view-tree" }
  | { type: "view-waterfall" }
  | { type: "fold-all"; mode: "collapsed" | "expanded" }
  | { type: "none" }

export function resolveTraceZenKeyboardAction(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  ctx: {
    focusedPane: ReviewPane
    viewMode: "tree" | "waterfall"
    foldMode: "collapsed" | "expanded" | "mixed"
  },
): TraceZenKeyboardAction {
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

  if (mod && key === "f") return { type: "open-filter" }
  if (key === "/" && !mod) return { type: "open-filter" }

  // Detail pane owns [ ] Space ←→ — never fold-all or switch Tree/Waterfall under it.
  if (ctx.focusedPane !== "tree") return { type: "none" }

  if (key === "t" && !mod) return { type: "view-tree" }
  if (key === "w" && !mod) return { type: "view-waterfall" }

  if (ctx.viewMode !== "tree") return { type: "none" }

  const bracket = resolveBracketDirection(event)
  if (bracket === -1 && ctx.foldMode !== "collapsed") {
    return { type: "fold-all", mode: "collapsed" }
  }
  if (bracket === 1 && ctx.foldMode !== "expanded") {
    return { type: "fold-all", mode: "expanded" }
  }

  return { type: "none" }
}
