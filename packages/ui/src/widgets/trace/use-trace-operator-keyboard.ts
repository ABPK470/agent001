/**
 * Trace operator surface — scope drawer, filter/view, Z, review pane, tree nav.
 * Claims one OperatorSurface; composition root owns the window listener.
 */

import { useMemo, useRef, type RefObject } from "react"
import { useReviewOperatorKeyboard } from "../../hooks/useReviewOperatorKeyboard"
import {
  resolveTraceZenKeyboardAction,
  type ReviewTreeKeyboardNode,
  type ReviewTreeListHandle,
  type TracePane,
} from "../../lib/keymap"
import type { DetailSectionController } from "../../lib/review/detail-section-controller"
import type { OperatorSurfaceHandler } from "../../lib/operator-surface"
import type { TraceTreeNode } from "./trace-tree-index"

function toKeyboardNodes(nodes: readonly TraceTreeNode[]): ReviewTreeKeyboardNode[] {
  return nodes.map((node, flatIndex) => ({
    scopeId: node.scopeId,
    parentScopeId: node.parentScopeId,
    hasChildren: node.hasChildren,
    flatIndex,
  }))
}

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
  onToggleZen,
  onViewModeChange,
  treeScrollRef,
  detailScrollRef,
  tabCycleRef,
  sectionControllerRef,
  treeNav,
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
  onToggleZen: () => void
  onViewModeChange: (mode: "tree" | "waterfall") => void
  treeScrollRef: RefObject<HTMLElement | null>
  detailScrollRef: RefObject<HTMLElement | null>
  tabCycleRef: RefObject<((direction: -1 | 1) => void) | null>
  sectionControllerRef?: RefObject<DetailSectionController | null>
  treeNav: {
    enabled: boolean
    nodes: readonly TraceTreeNode[]
    selectedScopeId: string | null
    isFolded: (node: TraceTreeNode) => boolean
    onSelect: (scopeId: string) => void
    onToggleFold: (scopeId: string) => void
    listRef: RefObject<ReviewTreeListHandle | null>
  }
}) {
  const isZenRef = useRef(isZen)
  const onToggleZenRef = useRef(onToggleZen)
  const onExitZenRef = useRef(onExitZen)
  const onSearchOpenChangeRef = useRef(onSearchOpenChange)
  const onViewModeChangeRef = useRef(onViewModeChange)
  const onScopeDrawerOpenChangeRef = useRef(onScopeDrawerOpenChange)
  const scopeDrawerOpenRef = useRef(scopeDrawerOpen)
  const focusedPaneRef = useRef(focusedPane)
  isZenRef.current = isZen
  onToggleZenRef.current = onToggleZen
  onExitZenRef.current = onExitZen
  onSearchOpenChangeRef.current = onSearchOpenChange
  onViewModeChangeRef.current = onViewModeChange
  onScopeDrawerOpenChangeRef.current = onScopeDrawerOpenChange
  scopeDrawerOpenRef.current = scopeDrawerOpen
  focusedPaneRef.current = focusedPane

  const beforePaneRef = useRef<OperatorSurfaceHandler | null>(null)
  beforePaneRef.current = (event) => {
    const mod = event.metaKey || event.ctrlKey
    if (mod && (event.key === "\\" || event.code === "Backslash")) {
      onScopeDrawerOpenChangeRef.current(!scopeDrawerOpenRef.current)
      return true
    }

    const key = event.key.toLowerCase()
    if (key === "z" && !mod && !event.altKey && !event.shiftKey) {
      if (isZenRef.current) onExitZenRef.current()
      else onToggleZenRef.current()
      return true
    }

    const zen = resolveTraceZenKeyboardAction(event, {
      focusedPane: focusedPaneRef.current,
    })
    if (zen.type === "open-filter") {
      onSearchOpenChangeRef.current(true)
      return true
    }
    if (zen.type === "view-tree") {
      onViewModeChangeRef.current("tree")
      return true
    }
    if (zen.type === "view-waterfall") {
      onViewModeChangeRef.current("waterfall")
      return true
    }
    return false
  }

  const keyboardNodes = useMemo(() => toKeyboardNodes(treeNav.nodes), [treeNav.nodes])
  const isFoldedFn = treeNav.isFolded
  const isFoldedKeyboard = useMemo(
    () => (node: ReviewTreeKeyboardNode) => {
      const traceNode = treeNav.nodes.find((n) => n.scopeId === node.scopeId)
      return traceNode ? isFoldedFn(traceNode) : false
    },
    [treeNav.nodes, isFoldedFn],
  )

  useReviewOperatorKeyboard({
    enabled,
    surfaceId: "trace",
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
    beforePaneRef,
    treeNav: {
      enabled: treeNav.enabled,
      nodes: keyboardNodes,
      selectedScopeId: treeNav.selectedScopeId,
      isFolded: isFoldedKeyboard,
      onSelect: treeNav.onSelect,
      onToggleFold: treeNav.onToggleFold,
      listRef: treeNav.listRef,
    },
  })
}
