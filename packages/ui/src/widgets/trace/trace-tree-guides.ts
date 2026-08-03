/**
 * IDE-style tree guide slots for flat trace tree rows.
 *
 * Left geometry (Trace + Pipelines share this dialect):
 *   panel edge → button `--trace-tree-hpad` → node-cell
 *   `base-pad + depth * indent` → chevron → icon → text.
 *
 * Pipelines: pipeline row depth 0; activities use flat-row depth as-is
 * (1 = Preview/Execute under pipeline, 2+ = nested tasks).
 */

import type { CSSProperties } from "react"

export const TRACE_TREE_HPAD_PX = 16
export const TRACE_TREE_BASE_PAD_PX = 16
export const TRACE_TREE_INDENT_PX = 20
export const TRACE_TREE_GUIDE_SLOT_PX = TRACE_TREE_INDENT_PX
/** Depth-0 chevron distance from the bordered sidebar edge. */
export const TRACE_TREE_ROOT_INSET_PX = TRACE_TREE_HPAD_PX + TRACE_TREE_BASE_PAD_PX

/** Wire Trace depth tokens onto a node-cell (Pipelines uses the same). */
export function traceTreeNodeCellStyle(depth: number): CSSProperties {
  return {
    ["--trace-tree-depth" as string]: Math.max(0, depth),
    ["--trace-tree-base-pad" as string]: `${TRACE_TREE_BASE_PAD_PX}px`,
    ["--trace-tree-indent" as string]: `${TRACE_TREE_INDENT_PX}px`,
  }
}

export type TraceTreeGuideSlot = "blank" | "line" | "branch" | "corner"

type GuideNode = { depth: number; parentScopeId: string | null }

export function isLastSibling(nodes: GuideNode[], index: number): boolean {
  const node = nodes[index]
  if (!node) return true
  for (let j = index + 1; j < nodes.length; j++) {
    const next = nodes[j]!
    if (next.depth < node.depth) return true
    if (next.depth === node.depth && next.parentScopeId === node.parentScopeId) {
      return false
    }
  }
  return true
}

/** Vertical guide at column `level` continues through this row. */
export function shouldDrawGuideLine(
  nodes: Array<{ depth: number }>,
  index: number,
  level: number,
): boolean {
  for (let j = index + 1; j < nodes.length; j++) {
    const next = nodes[j]!
    if (next.depth <= level) return false
    return true
  }
  return false
}

export function buildGuideSlots(nodes: GuideNode[], index: number): TraceTreeGuideSlot[] {
  const node = nodes[index]
  if (!node || node.depth <= 0) return []

  const slots: TraceTreeGuideSlot[] = []
  for (let level = 0; level < node.depth - 1; level++) {
    slots.push(shouldDrawGuideLine(nodes, index, level) ? "line" : "blank")
  }
  slots.push(isLastSibling(nodes, index) ? "corner" : "branch")
  return slots
}

export function annotateTreeGuideSlots<
  T extends GuideNode & { guideSlots?: TraceTreeGuideSlot[] },
>(nodes: T[]): void {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i]!.guideSlots = buildGuideSlots(nodes, i)
  }
}
