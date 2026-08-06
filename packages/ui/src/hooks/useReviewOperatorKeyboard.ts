/**
 * Shared review operator keyboard — pane ownership, detail scroll/sections/tabs, Esc ladder.
 * Tree row nav stays in useReviewTreeKeyboard (gated on focusedPane === "tree" by host).
 */

import { useEffect, useRef, type RefObject } from "react"
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
  const focusedPaneRef = useRef(focusedPane)
  const filterOpenRef = useRef(filterOpen)
  const scopeDrawerOpenRef = useRef(scopeDrawerOpen)
  const isZenRef = useRef(isZen)
  const isSoloRef = useRef(isSolo)
  const summonOpenRef = useRef(summonOpen)
  const lateralRef = useRef(lateral)
  focusedPaneRef.current = focusedPane
  filterOpenRef.current = filterOpen
  scopeDrawerOpenRef.current = scopeDrawerOpen
  isZenRef.current = isZen
  isSoloRef.current = isSolo
  summonOpenRef.current = summonOpen
  lateralRef.current = lateral

  const onFocusedPaneChangeRef = useRef(onFocusedPaneChange)
  const onFilterOpenChangeRef = useRef(onFilterOpenChange)
  const onScopeDrawerOpenChangeRef = useRef(onScopeDrawerOpenChange)
  const onExitZenRef = useRef(onExitZen)
  const onRestoreMaximizeRef = useRef(onRestoreMaximize)
  const onDismissSummonRef = useRef(onDismissSummon)
  onFocusedPaneChangeRef.current = onFocusedPaneChange
  onFilterOpenChangeRef.current = onFilterOpenChange
  onScopeDrawerOpenChangeRef.current = onScopeDrawerOpenChange
  onExitZenRef.current = onExitZen
  onRestoreMaximizeRef.current = onRestoreMaximize
  onDismissSummonRef.current = onDismissSummon

  useEffect(() => {
    if (!enabled) return

    function focusPane(pane: ReviewPane) {
      onFocusedPaneChangeRef.current(pane)
      const el = pane === "tree" ? treeScrollRef.current : detailScrollRef.current
      el?.focus({ preventScroll: true })
      if (pane === "tree") sectionControllerRef?.current?.clearActive()
    }

    function onKeyDown(event: KeyboardEvent) {
      const editable = isEditableKeyboardTarget(event.target)
      const pane = focusedPaneRef.current

      if (event.key === "Escape") {
        const action = resolveEscLadder({
          scopeDrawerOpen: scopeDrawerOpenRef.current,
          filterOpen: filterOpenRef.current,
          focusedPane: pane,
          isZen: isZenRef.current,
          isSolo: isSoloRef.current,
          summonOpen: summonOpenRef.current,
        })
        if (action.type === "none") return
        event.preventDefault()
        event.stopPropagation()
        if (action.type === "dismiss-scope-drawer") {
          onScopeDrawerOpenChangeRef.current?.(false)
          return
        }
        if (action.type === "dismiss-filter") {
          onFilterOpenChangeRef.current?.(false)
          if (event.target instanceof HTMLElement) event.target.blur()
          focusPane("tree")
          return
        }
        if (action.type === "pane-to-tree") {
          focusPane("tree")
          return
        }
        if (action.type === "exit-zen") {
          onExitZenRef.current?.()
          return
        }
        if (action.type === "restore-maximize") {
          onRestoreMaximizeRef.current?.()
          return
        }
        if (action.type === "dismiss-summon") {
          onDismissSummonRef.current?.()
        }
        return
      }

      if (editable) return
      if (scopeDrawerOpenRef.current) return

      const paneAction = resolveReviewPaneKeyboardAction(event, pane, {
        lateral: lateralRef.current,
      })
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
        focusPane(pane === "tree" ? "detail" : "tree")
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
      const sections = sectionControllerRef?.current
      if (paneAction.type === "cycle-tab") {
        // Call tabs when present; otherwise fold the active detail section (phase JSON, etc.).
        if (tabCycleRef?.current) {
          tabCycleRef.current(paneAction.direction)
          return
        }
        sections?.fold(paneAction.direction > 0)
        return
      }
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

    // Capture phase: win against zen fold-all / other bubble listeners.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [detailScrollRef, enabled, sectionControllerRef, tabCycleRef, treeScrollRef])
}
