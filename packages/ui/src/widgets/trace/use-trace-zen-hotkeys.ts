/**
 * Trace zen hotkeys — view mode, filter overlay, focus toggle, fold all.
 */

import { useEffect } from "react"
import { isEditableKeyboardTarget } from "../../lib/keyboard-target"
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
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return

      const key = event.key.toLowerCase()
      const mod = event.metaKey || event.ctrlKey

      if (key === "z" && !mod && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        if (isZen) onExitZen()
        else onToggleZen()
        return
      }

      if (!isZen) return

      if (event.key === "Escape") {
        if (searchOpen) {
          event.preventDefault()
          onSearchOpenChange(false)
          return
        }
        event.preventDefault()
        onExitZen()
        return
      }

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
        return
      }

      if (event.key === "Tab" && !mod) {
        event.preventDefault()
        onViewModeChange(viewMode === "tree" ? "waterfall" : "tree")
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    enabled,
    foldMode,
    isZen,
    onExitZen,
    onFoldModeChange,
    onSearchOpenChange,
    onToggleZen,
    onViewModeChange,
    searchOpen,
    viewMode,
  ])
}
