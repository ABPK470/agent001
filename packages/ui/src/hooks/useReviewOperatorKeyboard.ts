/**
 * Shared review operator keyboard — pane ownership, detail scroll/sections/tabs, Esc ladder.
 * Tree row nav stays in useReviewTreeKeyboard (gated on focusedPane === "tree" by host).
 */

import { useEffect, type RefObject } from "react"
import { isEditableKeyboardTarget } from "../lib/keyboard-target"
import {
  detailScrollPageDelta,
  resolveEscLadder,
  resolveReviewPaneKeyboardAction,
  type DetailLateralMode,
  type ReviewPane,
} from "../lib/keymap"
import type { DetailSectionController } from "../lib/review/detail-section-controller"

export function useReviewOperatorKeyboard({
  enabled,
  focusedPane,
  onFocusedPaneChange,
  filterOpen = false,
  onFilterOpenChange,
  scopeDrawerOpen = false,
  onScopeDrawerOpenChange,
  isZen = false,
  isSolo = false,
  summonOpen = false,
  onExitZen,
  onRestoreMaximize,
  onDismissSummon,
  treeScrollRef,
  detailScrollRef,
  tabCycleRef,
  sectionControllerRef,
  lateral = "sections",
}: {
  enabled: boolean
  focusedPane: ReviewPane
  onFocusedPaneChange: (pane: ReviewPane) => void
  filterOpen?: boolean
  onFilterOpenChange?: (open: boolean) => void
  scopeDrawerOpen?: boolean
  onScopeDrawerOpenChange?: (open: boolean) => void
  isZen?: boolean
  isSolo?: boolean
  summonOpen?: boolean
  onExitZen?: () => void
  onRestoreMaximize?: () => void
  onDismissSummon?: () => void
  treeScrollRef: RefObject<HTMLElement | null>
  detailScrollRef: RefObject<HTMLElement | null>
  tabCycleRef?: RefObject<((direction: -1 | 1) => void) | null>
  sectionControllerRef?: RefObject<DetailSectionController | null>
  lateral?: DetailLateralMode
}) {
  useEffect(() => {
    if (!enabled) return

    function focusPane(pane: ReviewPane) {
      onFocusedPaneChange(pane)
      const el = pane === "tree" ? treeScrollRef.current : detailScrollRef.current
      el?.focus({ preventScroll: true })
      if (pane === "tree") sectionControllerRef?.current?.clearActive()
    }

    function onKeyDown(event: KeyboardEvent) {
      const editable = isEditableKeyboardTarget(event.target)

      if (event.key === "Escape") {
        const action = resolveEscLadder({
          scopeDrawerOpen,
          filterOpen,
          focusedPane,
          isZen,
          isSolo,
          summonOpen,
        })
        if (action.type === "none") return
        event.preventDefault()
        event.stopPropagation()
        if (action.type === "dismiss-scope-drawer") {
          onScopeDrawerOpenChange?.(false)
          return
        }
        if (action.type === "dismiss-filter") {
          onFilterOpenChange?.(false)
          if (event.target instanceof HTMLElement) event.target.blur()
          focusPane("tree")
          return
        }
        if (action.type === "pane-to-tree") {
          focusPane("tree")
          return
        }
        if (action.type === "exit-zen") {
          onExitZen?.()
          return
        }
        if (action.type === "restore-maximize") {
          onRestoreMaximize?.()
          return
        }
        if (action.type === "dismiss-summon") {
          onDismissSummon?.()
        }
        return
      }

      if (editable) return
      if (scopeDrawerOpen) return

      const paneAction = resolveReviewPaneKeyboardAction(event, focusedPane, { lateral })
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
        tabCycleRef?.current?.(paneAction.direction)
        return
      }

      const sections = sectionControllerRef?.current
      if (paneAction.type === "section-move") {
        sections?.move(paneAction.direction)
        return
      }
      if (paneAction.type === "section-toggle") {
        sections?.toggle()
        return
      }
      if (paneAction.type === "section-fold") {
        sections?.fold(paneAction.open)
      }
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    detailScrollRef,
    enabled,
    filterOpen,
    focusedPane,
    isSolo,
    isZen,
    lateral,
    onDismissSummon,
    onExitZen,
    onFilterOpenChange,
    onFocusedPaneChange,
    onRestoreMaximize,
    onScopeDrawerOpenChange,
    scopeDrawerOpen,
    sectionControllerRef,
    summonOpen,
    tabCycleRef,
    treeScrollRef,
  ])
}
