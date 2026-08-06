/**
 * Review left-panel tree keyboard — arrows (+ vim hjkl), Home/End.
 * Claims an OperatorSurface; composition root owns the window listener.
 */

import { useRef, type RefObject } from "react"
import {
  resolveReviewTreeKeyboardAction,
  type ReviewTreeKeyboardNode,
  type ReviewTreeListHandle,
} from "../lib/keymap"
import type { OperatorSurfaceHandler } from "../lib/operator-surface"
import { useClaimOperatorSurface } from "./useClaimOperatorSurface"

export function useReviewTreeKeyboard({
  enabled,
  surfaceId = "review-tree",
  nodes,
  selectedScopeId,
  isFolded,
  onSelect,
  onToggleFold,
  listRef,
}: {
  enabled: boolean
  /** Unique claim id when multiple tree hosts can mount. */
  surfaceId?: string
  nodes: readonly ReviewTreeKeyboardNode[]
  selectedScopeId: string | null
  isFolded: (node: ReviewTreeKeyboardNode) => boolean
  onSelect: (scopeId: string) => void
  onToggleFold: (scopeId: string) => void
  listRef: RefObject<ReviewTreeListHandle | null>
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

  const onKeyDownRef = useRef<OperatorSurfaceHandler | null>(null)
  onKeyDownRef.current = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return false

    const action = resolveReviewTreeKeyboardAction(
      event.key,
      nodesRef.current,
      selectedRef.current,
      isFoldedRef.current,
    )
    if (!action) return false

    if (action.type === "toggleFold") {
      onToggleFoldRef.current(action.scopeId)
      return true
    }
    onSelectRef.current(action.scopeId)
    listRef.current?.scrollToIndex(action.flatIndex, { align: "auto" })
    return true
  }

  useClaimOperatorSurface(enabled, surfaceId, onKeyDownRef)
}
