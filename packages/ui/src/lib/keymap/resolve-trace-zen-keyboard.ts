/**
 * Trace zen / tile chords that are NOT review-pane-owned (filter, Tree/Waterfall).
 *
 * Bare `[` / `]` are NEVER fold-all — those keys belong to detail sections only
 * (and do nothing on the tree pane). Fold-all stays on the toolbar control.
 */

import type { ReviewPane } from "./resolve-review-pane-keyboard"

export type TraceZenKeyboardAction =
  | { type: "open-filter" }
  | { type: "view-tree" }
  | { type: "view-waterfall" }
  | { type: "none" }

export function resolveTraceZenKeyboardAction(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  ctx: {
    focusedPane: ReviewPane
  },
): TraceZenKeyboardAction {
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

  if (mod && key === "f") return { type: "open-filter" }
  if (key === "/" && !mod) return { type: "open-filter" }

  // View mode switches are tree-pane only — detail owns lateral / section keys.
  if (ctx.focusedPane !== "tree") return { type: "none" }

  if (key === "t" && !mod) return { type: "view-tree" }
  if (key === "w" && !mod) return { type: "view-waterfall" }

  return { type: "none" }
}
