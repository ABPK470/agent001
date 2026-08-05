/**
 * Trace left-panel tree keyboard — delegates to shared review hook.
 */

import { useMemo, type RefObject } from "react"
import type { VirtualListHandle } from "../../components/VirtualList"
import { useReviewTreeKeyboard } from "../../hooks/useReviewTreeKeyboard"
import type { ReviewTreeKeyboardNode } from "../../components/review/review-tree-keyboard"
import type { TraceTreeNode } from "./trace-tree-index"

function toKeyboardNodes(nodes: readonly TraceTreeNode[]): ReviewTreeKeyboardNode[] {
  return nodes.map((node, flatIndex) => ({
    scopeId: node.scopeId,
    parentScopeId: node.parentScopeId,
    hasChildren: node.hasChildren,
    flatIndex,
  }))
}

export function useTraceTreeKeyboard({
  enabled,
  nodes,
  selectedScopeId,
  isFolded,
  onSelect,
  onToggleFold,
  listRef,
}: {
  enabled: boolean
  nodes: readonly TraceTreeNode[]
  selectedScopeId: string | null
  isFolded: (node: TraceTreeNode) => boolean
  onSelect: (scopeId: string) => void
  onToggleFold: (scopeId: string) => void
  listRef: RefObject<VirtualListHandle | null>
}) {
  const keyboardNodes = useMemo(() => toKeyboardNodes(nodes), [nodes])
  const isFoldedKeyboard = useMemo(
    () => (node: ReviewTreeKeyboardNode) => {
      const traceNode = nodes.find((n) => n.scopeId === node.scopeId)
      return traceNode ? isFolded(traceNode) : false
    },
    [nodes, isFolded],
  )

  useReviewTreeKeyboard({
    enabled,
    nodes: keyboardNodes,
    selectedScopeId,
    isFolded: isFoldedKeyboard,
    onSelect,
    onToggleFold,
    listRef,
  })
}
