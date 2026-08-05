/**
 * Review left-panel tree keyboard — arrows (+ vim hjkl), Home/End.
 * Active when the host widget enables it (focused tile, zen, etc.).
 */

import { useEffect, useRef, type RefObject } from "react"
import type { VirtualListHandle } from "../components/VirtualList"
import {
  resolveReviewTreeKeyboardAction,
  type ReviewTreeKeyboardNode,
} from "../components/review/review-tree-keyboard"
import { isEditableKeyboardTarget } from "../lib/keyboard-target"

export function useReviewTreeKeyboard({
  enabled,
  nodes,
  selectedScopeId,
  isFolded,
  onSelect,
  onToggleFold,
  listRef,
}: {
  enabled: boolean
  nodes: readonly ReviewTreeKeyboardNode[]
  selectedScopeId: string | null
  isFolded: (node: ReviewTreeKeyboardNode) => boolean
  onSelect: (scopeId: string) => void
  onToggleFold: (scopeId: string) => void
  listRef: RefObject<VirtualListHandle | null>
}) {
  const nodesRef = useRef(nodes)
  const selectedRef = useRef(selectedScopeId)
  const isFoldedRef = useRef(isFolded)
  const onSelectRef = useRef(onSelect)
  const onToggleFoldRef = useRef(onToggleFold)

  nodesRef.current = nodes
  selectedRef.current = selectedScopeId
  isFoldedRef.current = isFolded
  onSelectRef.current = onSelect
  onToggleFoldRef.current = onToggleFold

  useEffect(() => {
    if (!enabled) return

    function onKeyDown(event: KeyboardEvent) {
      if (isEditableKeyboardTarget(event.target)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return

      const action = resolveReviewTreeKeyboardAction(
        event.key,
        nodesRef.current,
        selectedRef.current,
        isFoldedRef.current,
      )
      if (!action) return

      event.preventDefault()
      if (action.type === "toggleFold") {
        onToggleFoldRef.current(action.scopeId)
        return
      }
      onSelectRef.current(action.scopeId)
      listRef.current?.scrollToIndex(action.flatIndex, { align: "auto" })
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, listRef])
}
