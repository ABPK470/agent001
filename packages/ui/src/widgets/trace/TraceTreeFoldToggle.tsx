/**
 * Tree fold-all — zen HUD peer of ReviewTreeFoldToggle (same icons, zen chrome).
 */

import { ReviewTreeFoldToggle } from "../../components/review"
import type { FoldMode } from "./open-state"

export function TraceTreeFoldToggle({
  foldMode,
  onFoldModeChange,
}: {
  foldMode: FoldMode
  onFoldModeChange: (mode: FoldMode) => void
}) {
  const expanded = foldMode === "expanded"

  return (
    <ReviewTreeFoldToggle
      foldMode={foldMode}
      onFoldModeChange={onFoldModeChange}
      className="trace-zen-hud__icon-btn"
      title={expanded ? "Collapse all ([)" : "Expand all (])"}
      ariaLabel={
        expanded ? "Collapse all trace scopes" : "Expand all trace scopes"
      }
    />
  )
}
