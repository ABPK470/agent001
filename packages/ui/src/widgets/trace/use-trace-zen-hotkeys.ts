/**
 * Trace zen / focused-tile hotkeys — view mode, filter overlay, fold all, Z.
 * Esc owned by useTraceOperatorKeyboard (ladder). Tab no longer toggles view.
 *
 * `[` / `]` fold-all is tree-pane only — detail pane uses those keys for sections.
 * Pane ownership is read from a ref so fold-all cannot fire on a stale "tree" closure.
 */

import { useEffect, useRef } from "react"
import { isEditableKeyboardTarget } from "../../lib/keyboard-target"
import { useWidgetZenHotkeys } from "../../hooks/useWidgetZenHotkeys"
import { resolveTraceZenKeyboardAction, type TracePane } from "../../lib/keymap"
import type { FoldMode } from "./open-state"

export function useTraceZenHotkeys({
  enabled,
  isZen,
  searchOpen,
  onSearchOpenChange,
  onViewModeChange,
  viewMode,
  focusedPane,
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
  focusedPane: TracePane
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

  const focusedPaneRef = useRef(focusedPane)
  const viewModeRef = useRef(viewMode)
  const foldModeRef = useRef(foldMode)
  const onSearchOpenChangeRef = useRef(onSearchOpenChange)
  const onViewModeChangeRef = useRef(onViewModeChange)
  const onFoldModeChangeRef = useRef(onFoldModeChange)
  focusedPaneRef.current = focusedPane
  viewModeRef.current = viewMode
  foldModeRef.current = foldMode
  onSearchOpenChangeRef.current = onSearchOpenChange
  onViewModeChangeRef.current = onViewModeChange
  onFoldModeChangeRef.current = onFoldModeChange

  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return

      const action = resolveTraceZenKeyboardAction(event, {
        focusedPane: focusedPaneRef.current,
        viewMode: viewModeRef.current,
        foldMode: foldModeRef.current,
      })
      if (action.type === "none") return

      event.preventDefault()
      event.stopPropagation()

      if (action.type === "open-filter") {
        onSearchOpenChangeRef.current(true)
        return
      }
      if (action.type === "view-tree") {
        onViewModeChangeRef.current("tree")
        return
      }
      if (action.type === "view-waterfall") {
        onViewModeChangeRef.current("waterfall")
        return
      }
      if (action.type === "fold-all") {
        onFoldModeChangeRef.current(action.mode)
      }
    }

    // Capture so fold-all cannot lose a race to other bubble listeners with a stale pane.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [enabled])
}
