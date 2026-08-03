/**
 * Trace tree geometry tokens + guide-slot helpers (algorithm shared with
 * Pipelines; Trace rows currently indent via depth padding, not hairlines).
 */

import type { CSSProperties } from "react"
import {
  annotateTreeGuideSlots,
  buildGuideSlots,
  isLastSibling,
  shouldDrawGuideLine,
  type ReviewTreeGuideSlot,
} from "../../components/review/review-tree-guides"

export type TraceTreeGuideSlot = ReviewTreeGuideSlot
export {
  annotateTreeGuideSlots,
  buildGuideSlots,
  isLastSibling,
  shouldDrawGuideLine,
}

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
