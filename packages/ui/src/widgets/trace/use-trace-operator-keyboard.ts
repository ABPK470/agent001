/**
 * Trace operator keyboard — scope drawer chord + shared review pane ownership.
 * Z stays in useWidgetZenHotkeys; tree row nav stays in useTraceTreeKeyboard.
 */

import { useEffect, type RefObject } from "react"
import { useReviewOperatorKeyboard } from "../../hooks/useReviewOperatorKeyboard"
import { isEditableKeyboardTarget } from "../../lib/keyboard-target"
import type { DetailSectionController } from "../../lib/review/detail-section-controller"
import type { TracePane } from "../../lib/keymap"

export function useTraceOperatorKeyboard({
  enabled,
  focusedPane,
  onFocusedPaneChange,
  searchOpen,
  onSearchOpenChange,
  scopeDrawerOpen,
  onScopeDrawerOpenChange,
  isZen,
  isSolo,
  summonOpen,
  onExitZen,
  onRestoreMaximize,
  onDismissSummon,
  treeScrollRef,
  detailScrollRef,
  tabCycleRef,
  sectionControllerRef,
}: {
  enabled: boolean
  focusedPane: TracePane
  onFocusedPaneChange: (pane: TracePane) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  scopeDrawerOpen: boolean
  onScopeDrawerOpenChange: (open: boolean) => void
  isZen: boolean
  isSolo: boolean
  summonOpen: boolean
  onExitZen: () => void
  onRestoreMaximize: () => void
  onDismissSummon: () => void
  treeScrollRef: RefObject<HTMLElement | null>
  detailScrollRef: RefObject<HTMLElement | null>
  tabCycleRef: RefObject<((direction: -1 | 1) => void) | null>
  sectionControllerRef?: RefObject<DetailSectionController | null>
}) {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key !== "\\" && event.code !== "Backslash") return
      event.preventDefault()
      event.stopPropagation()
      onScopeDrawerOpenChange(!scopeDrawerOpen)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, onScopeDrawerOpenChange, scopeDrawerOpen])

  useReviewOperatorKeyboard({
    enabled,
    focusedPane,
    onFocusedPaneChange,
    filterOpen: searchOpen,
    onFilterOpenChange: onSearchOpenChange,
    scopeDrawerOpen,
    onScopeDrawerOpenChange,
    isZen,
    isSolo,
    summonOpen,
    onExitZen,
    onRestoreMaximize,
    onDismissSummon,
    treeScrollRef,
    detailScrollRef,
    tabCycleRef,
    sectionControllerRef,
    lateral: "tabs",
  })
}
