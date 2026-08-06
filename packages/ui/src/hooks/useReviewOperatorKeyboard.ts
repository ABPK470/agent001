/**
 * Review master–detail operator surface — pane, Esc ladder, detail sections.
 * Does not listen on window; claims the active OperatorSurface for the composition root.
 * Tree row nav is folded in when `treeNav` is provided and pane === tree.
 *
 * Detail: ↑↓ move rows · ←→ fold cores · Space toggle · PgUp/Dn scroll.
 */

import { useRef, type RefObject } from "react"
import {
  detailScrollLineDelta,
  detailScrollPageDelta,
  resolveEscLadder,
  resolveReviewPaneKeyboardAction,
  resolveReviewTreeKeyboardAction,
  type ReviewPane,
  type ReviewTreeKeyboardNode,
  type ReviewTreeListHandle,
} from "../lib/keymap"
import type { DetailSectionController } from "../lib/review/detail-section-controller"
import type { OperatorSurfaceHandler } from "../lib/operator-surface"
import { useClaimOperatorSurface } from "./useClaimOperatorSurface"

export type ReviewTreeNavBinding = {
  enabled: boolean
  nodes: readonly ReviewTreeKeyboardNode[]
  selectedScopeId: string | null
  isFolded: (node: ReviewTreeKeyboardNode) => boolean
  onSelect: (scopeId: string) => void
  onToggleFold: (scopeId: string) => void
  listRef: RefObject<ReviewTreeListHandle | null>
}

function focusReviewPane(
  next: ReviewPane,
  onFocusedPaneChange: (pane: ReviewPane) => void,
  treeScrollRef: RefObject<HTMLElement | null>,
  detailScrollRef: RefObject<HTMLElement | null>,
  sectionControllerRef?: RefObject<DetailSectionController | null>,
): void {
  onFocusedPaneChange(next)
  const el = next === "tree" ? treeScrollRef.current : detailScrollRef.current
  el?.focus({ preventScroll: true })
  if (next === "tree") sectionControllerRef?.current?.clearActive()
}

export function useReviewOperatorKeyboard({
  enabled,
  surfaceId,
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
  treeNav = null,
  /** Extra chords before pane resolve (Trace: scope drawer, filter, T/W, Z). */
  beforePaneRef,
}: {
  enabled: boolean
  surfaceId: string
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
  treeNav?: ReviewTreeNavBinding | null
  beforePaneRef?: RefObject<OperatorSurfaceHandler | null>
}) {
  const focusedPaneRef = useRef(focusedPane)
  const filterOpenRef = useRef(filterOpen)
  const scopeDrawerOpenRef = useRef(scopeDrawerOpen)
  const isZenRef = useRef(isZen)
  const isSoloRef = useRef(isSolo)
  const summonOpenRef = useRef(summonOpen)
  const treeNavRef = useRef(treeNav)
  focusedPaneRef.current = focusedPane
  filterOpenRef.current = filterOpen
  scopeDrawerOpenRef.current = scopeDrawerOpen
  isZenRef.current = isZen
  isSoloRef.current = isSolo
  summonOpenRef.current = summonOpen
  treeNavRef.current = treeNav

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

  const onKeyDownRef = useRef<OperatorSurfaceHandler | null>(null)
  onKeyDownRef.current = (event) => {
    if (beforePaneRef?.current?.(event)) return true

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
      if (action.type === "none") return false
      if (action.type === "dismiss-scope-drawer") {
        onScopeDrawerOpenChangeRef.current?.(false)
        return true
      }
      if (action.type === "dismiss-filter") {
        onFilterOpenChangeRef.current?.(false)
        if (event.target instanceof HTMLElement) event.target.blur()
        focusReviewPane(
          "tree",
          onFocusedPaneChangeRef.current,
          treeScrollRef,
          detailScrollRef,
          sectionControllerRef,
        )
        return true
      }
      if (action.type === "pane-to-tree") {
        focusReviewPane(
          "tree",
          onFocusedPaneChangeRef.current,
          treeScrollRef,
          detailScrollRef,
          sectionControllerRef,
        )
        return true
      }
      if (action.type === "exit-zen") {
        onExitZenRef.current?.()
        return true
      }
      if (action.type === "restore-maximize") {
        onRestoreMaximizeRef.current?.()
        return true
      }
      if (action.type === "dismiss-summon") {
        onDismissSummonRef.current?.()
        return true
      }
      return false
    }

    if (scopeDrawerOpenRef.current) return false

    const paneAction = resolveReviewPaneKeyboardAction(event, pane)
    if (paneAction.type !== "none") {
      if (paneAction.type === "pane-to-detail") {
        focusReviewPane(
          "detail",
          onFocusedPaneChangeRef.current,
          treeScrollRef,
          detailScrollRef,
          sectionControllerRef,
        )
        return true
      }
      if (paneAction.type === "pane-to-tree") {
        focusReviewPane(
          "tree",
          onFocusedPaneChangeRef.current,
          treeScrollRef,
          detailScrollRef,
          sectionControllerRef,
        )
        return true
      }
      if (paneAction.type === "toggle-pane") {
        focusReviewPane(
          pane === "tree" ? "detail" : "tree",
          onFocusedPaneChangeRef.current,
          treeScrollRef,
          detailScrollRef,
          sectionControllerRef,
        )
        return true
      }

      const scrollEl = detailScrollRef.current
      const sections = sectionControllerRef?.current

      if (paneAction.type === "detail-move") {
        if (sections?.move(paneAction.direction)) return true
        if (scrollEl) {
          scrollEl.scrollTop += paneAction.direction * detailScrollLineDelta()
          return true
        }
        return false
      }
      if (paneAction.type === "detail-scroll" && scrollEl) {
        scrollEl.scrollTop += paneAction.delta
        return true
      }
      if (paneAction.type === "detail-scroll-page" && scrollEl) {
        scrollEl.scrollTop += paneAction.direction * detailScrollPageDelta()
        return true
      }
      if (paneAction.type === "detail-scroll-edge" && scrollEl) {
        scrollEl.scrollTop = paneAction.edge === "start" ? 0 : scrollEl.scrollHeight
        return true
      }
      if (paneAction.type === "section-toggle") {
        sections?.toggle()
        return true
      }
      if (paneAction.type === "section-fold") {
        if (sections?.fold(paneAction.open)) return true
        // Call detail tabs when active row is not foldable / none registered.
        if (tabCycleRef?.current) {
          tabCycleRef.current(paneAction.open ? 1 : -1)
          return true
        }
        return true
      }
      return true
    }

    const nav = treeNavRef.current
    if (nav?.enabled && pane === "tree") {
      if (event.metaKey || event.ctrlKey || event.altKey) return false
      const action = resolveReviewTreeKeyboardAction(
        event.key,
        nav.nodes,
        nav.selectedScopeId,
        nav.isFolded,
      )
      if (!action) return false
      if (action.type === "toggleFold") {
        nav.onToggleFold(action.scopeId)
        return true
      }
      nav.onSelect(action.scopeId)
      nav.listRef.current?.scrollToIndex(action.flatIndex, { align: "auto" })
      return true
    }

    return false
  }

  useClaimOperatorSurface(enabled, surfaceId, onKeyDownRef)
}
