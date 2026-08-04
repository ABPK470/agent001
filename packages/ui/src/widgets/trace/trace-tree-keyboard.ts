/**
 * Pure helpers for Trace tree keyboard navigation (visible flat node list).
 */

import type { TraceTreeNode } from "./trace-tree-index"

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
  nodes: readonly TraceTreeNode[],
  parentIndex: number,
): number {
  const parent = nodes[parentIndex]
  if (!parent) return -1
  const next = nodes[parentIndex + 1]
  if (!next || next.parentScopeId !== parent.scopeId) return -1
  return parentIndex + 1
}

export function parentIndex(
  nodes: readonly TraceTreeNode[],
  childIndex: number,
): number {
  const child = nodes[childIndex]
  if (!child?.parentScopeId) return -1
  return nodes.findIndex((n) => n.scopeId === child.parentScopeId)
}

export type TreeKeyboardAction =
  | { type: "select"; scopeId: string; index: number }
  | { type: "toggleFold"; scopeId: string }

/**
 * Map a key to a tree action. Folded = children not visible in `nodes`.
 */
export function resolveTreeKeyboardAction(
  key: string,
  nodes: readonly TraceTreeNode[],
  selectedScopeId: string | null,
  isFolded: (node: TraceTreeNode) => boolean,
): TreeKeyboardAction | null {
  if (nodes.length === 0) return null
  const currentIndex = selectedScopeId
    ? nodes.findIndex((n) => n.scopeId === selectedScopeId)
    : -1
  const current = currentIndex >= 0 ? nodes[currentIndex]! : null

  if (key === "ArrowDown" || key === "j") {
    const next = adjacentTreeIndex(nodes.length, currentIndex, 1)
    if (next < 0) return null
    return { type: "select", scopeId: nodes[next]!.scopeId, index: next }
  }

  if (key === "ArrowUp" || key === "k") {
    const next = adjacentTreeIndex(nodes.length, currentIndex, -1)
    if (next < 0) return null
    return { type: "select", scopeId: nodes[next]!.scopeId, index: next }
  }

  if (key === "Home") {
    return { type: "select", scopeId: nodes[0]!.scopeId, index: 0 }
  }

  if (key === "End") {
    const last = nodes.length - 1
    return { type: "select", scopeId: nodes[last]!.scopeId, index: last }
  }

  if (!current || currentIndex < 0) return null

  if (key === "ArrowRight" || key === "l") {
    if (current.hasChildren && isFolded(current)) {
      return { type: "toggleFold", scopeId: current.scopeId }
    }
    const child = firstChildIndex(nodes, currentIndex)
    if (child >= 0) {
      return { type: "select", scopeId: nodes[child]!.scopeId, index: child }
    }
    return null
  }

  if (key === "ArrowLeft" || key === "h") {
    if (current.hasChildren && !isFolded(current)) {
      return { type: "toggleFold", scopeId: current.scopeId }
    }
    const parent = parentIndex(nodes, currentIndex)
    if (parent >= 0) {
      return { type: "select", scopeId: nodes[parent]!.scopeId, index: parent }
    }
    return null
  }

  return null
}
