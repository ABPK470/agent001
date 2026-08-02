/**
 * Tree fold-all — compact icon toggle for zen HUD leading cluster.
 * Lives beside run stats (tree chrome), not in column headers or session trailing.
 */

import { ListChevronsDownUp, ListChevronsUpDown } from "lucide-react"
import type { FoldMode } from "./open-state"

export function TraceTreeFoldToggle({
  foldMode,
  onFoldModeChange,
}: {
  foldMode: FoldMode
  onFoldModeChange: (mode: FoldMode) => void
}) {
  const expanded = foldMode === "expanded"

  function onToggle() {
    onFoldModeChange(expanded ? "collapsed" : "expanded")
  }

  return (
    <button
      type="button"
      className="trace-zen-hud__icon-btn"
      title={expanded ? "Collapse all ([)" : "Expand all (])"}
      aria-label={
        expanded ? "Collapse all trace scopes" : "Expand all trace scopes"
      }
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
