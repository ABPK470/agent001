/**
 * Tree fold-all — one icon for Pipelines + Trace toolbars (and Trace zen HUD).
 * ListChevrons: expand-all vs collapse-all — quiet peer of filter/download icon buttons.
 */

import type { JSX } from "react"
import { ListChevronsDownUp, ListChevronsUpDown } from "lucide-react"
import type { ReviewTreeFoldMode } from "./review-tree-open-state"

export function ReviewTreeFoldToggle({
  foldMode,
  onFoldModeChange,
  ariaLabel = "Expand or collapse all tree scopes",
  title,
  className = "widget-toolbar__icon-btn",
}: {
  foldMode: ReviewTreeFoldMode
  onFoldModeChange: (mode: ReviewTreeFoldMode) => void
  ariaLabel?: string
  title?: string
  className?: string
}): JSX.Element {
  const expanded = foldMode === "expanded"

  function onToggle() {
    onFoldModeChange(expanded ? "collapsed" : "expanded")
  }

  return (
    <button
      type="button"
      className={className}
      title={title ?? (expanded ? "Collapse all" : "Expand all")}
      aria-label={ariaLabel}
      aria-pressed={expanded}
      onClick={onToggle}
    >
      {expanded ? (
        <ListChevronsDownUp size={14} strokeWidth={1.75} aria-hidden />
      ) : (
        <ListChevronsUpDown size={14} strokeWidth={1.75} aria-hidden />
      )}
    </button>
  )
}
