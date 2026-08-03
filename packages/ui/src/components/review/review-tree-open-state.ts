/**
 * Generic fold-all helpers for operator-review tree panes.
 */

export type ReviewTreeFoldMode = "expanded" | "collapsed"

export function reviewTreeOpenStateForMode<T extends string>(
  mode: ReviewTreeFoldMode,
  expanded: () => ReadonlySet<T>,
  collapsed: () => ReadonlySet<T>,
): ReadonlySet<T> {
  return mode === "expanded" ? expanded() : collapsed()
}
