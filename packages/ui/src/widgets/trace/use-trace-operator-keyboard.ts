/**
 * Trace operator keyboard — pane ownership, detail scroll/tabs, Esc ladder.
 * Z stays in useWidgetZenHotkeys; tree row nav stays in useTraceTreeKeyboard.
 */

import { useEffect, type RefObject } from "react"
import { isEditableKeyboardTarget } from "../../lib/keyboard-target"
import {
  detailScrollPageDelta,
  resolveEscLadder,
  resolveTracePaneKeyboardAction,
  type TracePane,
} from "../../lib/keymap"

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
}) {
  useEffect(() => {
    if (!enabled) return

    function focusPane(pane: TracePane) {
      onFocusedPaneChange(pane)
      const el = pane === "tree" ? treeScrollRef.current : detailScrollRef.current
      el?.focus({ preventScroll: true })
    }

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return

      // ⌘\ / Ctrl+\ — toggle Thread/Run scope drawer
      if ((event.metaKey || event.ctrlKey) && (event.key === "\\" || event.code === "Backslash")) {
        event.preventDefault()
        event.stopPropagation()
        onScopeDrawerOpenChange(!scopeDrawerOpen)
        return
      }

      if (event.key === "Escape") {
        const action = resolveEscLadder({
          scopeDrawerOpen,
          filterOpen: searchOpen,
          focusedPane,
          isZen,
          isSolo,
          summonOpen,
        })
        if (action.type === "none") return
        event.preventDefault()
        event.stopPropagation()
        if (action.type === "dismiss-scope-drawer") {
          onScopeDrawerOpenChange(false)
          return
        }
        if (action.type === "dismiss-filter") {
          onSearchOpenChange(false)
          return
        }
        if (action.type === "pane-to-tree") {
          focusPane("tree")
          return
        }
        if (action.type === "exit-zen") {
          onExitZen()
          return
        }
        if (action.type === "restore-maximize") {
          onRestoreMaximize()
          return
        }
        if (action.type === "dismiss-summon") {
          onDismissSummon()
        }
        return
      }

      const paneAction = resolveTracePaneKeyboardAction(event, focusedPane)
      if (paneAction.type === "none") return

      event.preventDefault()
      event.stopPropagation()

      if (paneAction.type === "pane-to-detail") {
        focusPane("detail")
        return
      }
      if (paneAction.type === "pane-to-tree") {
        focusPane("tree")
        return
      }
      if (paneAction.type === "toggle-pane") {
        focusPane(focusedPane === "tree" ? "detail" : "tree")
        return
      }

      const scrollEl = detailScrollRef.current
      if (paneAction.type === "detail-scroll" && scrollEl) {
        scrollEl.scrollTop += paneAction.delta
        return
      }
      if (paneAction.type === "detail-scroll-page" && scrollEl) {
        scrollEl.scrollTop += paneAction.direction * detailScrollPageDelta()
        return
      }
      if (paneAction.type === "detail-scroll-edge" && scrollEl) {
        scrollEl.scrollTop = paneAction.edge === "start" ? 0 : scrollEl.scrollHeight
        return
      }
      if (paneAction.type === "cycle-tab") {
        tabCycleRef.current?.(paneAction.direction)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    detailScrollRef,
    enabled,
    focusedPane,
    isSolo,
    isZen,
    onDismissSummon,
    onExitZen,
    onFocusedPaneChange,
    onRestoreMaximize,
    onScopeDrawerOpenChange,
    onSearchOpenChange,
    scopeDrawerOpen,
    searchOpen,
    summonOpen,
    tabCycleRef,
    treeScrollRef,
  ])
}
