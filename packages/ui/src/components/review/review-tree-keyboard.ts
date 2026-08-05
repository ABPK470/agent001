/**
 * Pure helpers for review left-tree keyboard navigation (visible flat node list).
 */

export type ReviewTreeKeyboardNode = {
  scopeId: string
  parentScopeId: string | null
  hasChildren: boolean
  /** Index in the host VirtualList (for scroll-into-view). */
  flatIndex: number
}

/** Next/prev index in the visible list. Empty → -1; no selection → wrap from ends. */
export function adjacentTreeIndex(
  length: number,
  currentIndex: number,
  delta: -1 | 1,
): number {
  if (length <= 0) return -1
  if (currentIndex < 0) return delta > 0 ? 0 : length - 1
  return Math.max(0, Math.min(length - 1, currentIndex + delta))
}

export function firstChildIndex(
  nodes: readonly ReviewTreeKeyboardNode[],
  parentIndex: number,
): number {
  const parent = nodes[parentIndex]
  if (!parent) return -1
  const next = nodes[parentIndex + 1]
  if (!next || next.parentScopeId !== parent.scopeId) return -1
  return parentIndex + 1
}

export function parentIndex(
  nodes: readonly ReviewTreeKeyboardNode[],
  childIndex: number,
): number {
  const child = nodes[childIndex]
  if (!child?.parentScopeId) return -1
  return nodes.findIndex((n) => n.scopeId === child.parentScopeId)
}

export type ReviewTreeKeyboardAction =
  | { type: "select"; scopeId: string; flatIndex: number }
  | { type: "toggleFold"; scopeId: string }

/**
 * Map a key to a tree action. Folded = children not visible in `nodes`.
 */
export function resolveReviewTreeKeyboardAction(
  key: string,
  nodes: readonly ReviewTreeKeyboardNode[],
  selectedScopeId: string | null,
  isFolded: (node: ReviewTreeKeyboardNode) => boolean,
): ReviewTreeKeyboardAction | null {
  if (nodes.length === 0) return null
  const currentIndex = selectedScopeId
    ? nodes.findIndex((n) => n.scopeId === selectedScopeId)
    : -1
  const current = currentIndex >= 0 ? nodes[currentIndex]! : null

  if (key === "ArrowDown" || key === "j") {
    const next = adjacentTreeIndex(nodes.length, currentIndex, 1)
    if (next < 0) return null
    const node = nodes[next]!
    return { type: "select", scopeId: node.scopeId, flatIndex: node.flatIndex }
  }

  if (key === "ArrowUp" || key === "k") {
    const next = adjacentTreeIndex(nodes.length, currentIndex, -1)
    if (next < 0) return null
    const node = nodes[next]!
    return { type: "select", scopeId: node.scopeId, flatIndex: node.flatIndex }
  }

  if (key === "Home") {
    const node = nodes[0]!
    return { type: "select", scopeId: node.scopeId, flatIndex: node.flatIndex }
  }

  if (key === "End") {
    const node = nodes[nodes.length - 1]!
    return { type: "select", scopeId: node.scopeId, flatIndex: node.flatIndex }
  }

  if (!current || currentIndex < 0) return null

  if (key === "ArrowRight" || key === "l") {
    if (current.hasChildren && isFolded(current)) {
      return { type: "toggleFold", scopeId: current.scopeId }
    }
    const child = firstChildIndex(nodes, currentIndex)
    if (child >= 0) {
      const node = nodes[child]!
      return { type: "select", scopeId: node.scopeId, flatIndex: node.flatIndex }
    }
    return null
  }

  if (key === "ArrowLeft" || key === "h") {
    if (current.hasChildren && !isFolded(current)) {
      return { type: "toggleFold", scopeId: current.scopeId }
    }
    const parent = parentIndex(nodes, currentIndex)
    if (parent >= 0) {
      const node = nodes[parent]!
      return { type: "select", scopeId: node.scopeId, flatIndex: node.flatIndex }
    }
    return null
  }

  return null
}
