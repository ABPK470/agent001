/**
 * Trace zen / focused-tile hotkeys — view mode, filter overlay, fold all, Z.
 * Esc owned by useTraceOperatorKeyboard (ladder). Tab no longer toggles view.
 */

import { useEffect } from "react"
import { isEditableKeyboardTarget } from "../../lib/keyboard-target"
import { useWidgetZenHotkeys } from "../../hooks/useWidgetZenHotkeys"
import type { FoldMode } from "./open-state"

export function useTraceZenHotkeys({
  enabled,
  isZen,
  searchOpen,
  onSearchOpenChange,
  onViewModeChange,
  viewMode,
  foldMode,
  onFoldModeChange,
  onToggleZen,
  onExitZen,
}: {
  enabled: boolean
  isZen: boolean
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  onViewModeChange: (mode: "tree" | "waterfall") => void
  viewMode: "tree" | "waterfall"
  foldMode: FoldMode
  onFoldModeChange: (mode: FoldMode) => void
  onToggleZen: () => void
  onExitZen: () => void
}) {
  useWidgetZenHotkeys({
    enabled,
    isZen,
    onToggleZen,
    onExitZen,
    handleEscape: false,
  })

  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return

      const key = event.key.toLowerCase()
      const mod = event.metaKey || event.ctrlKey

      if (mod && key === "f") {
        event.preventDefault()
        onSearchOpenChange(true)
        return
      }

      if (key === "/" && !mod) {
        event.preventDefault()
        onSearchOpenChange(true)
        return
      }

      if (key === "t" && !mod) {
        event.preventDefault()
        onViewModeChange("tree")
        return
      }

      if (key === "w" && !mod) {
        event.preventDefault()
        onViewModeChange("waterfall")
        return
      }

      if (viewMode === "tree" && key === "[" && !mod) {
        event.preventDefault()
        if (foldMode !== "collapsed") onFoldModeChange("collapsed")
        return
      }

      if (viewMode === "tree" && key === "]" && !mod) {
        event.preventDefault()
        if (foldMode !== "expanded") onFoldModeChange("expanded")
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    enabled,
    foldMode,
    onFoldModeChange,
    onSearchOpenChange,
    onViewModeChange,
    viewMode,
  ])
}
