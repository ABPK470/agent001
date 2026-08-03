/**
 * Operator-review tree gutter geometry — canonical contract for split-pane trees.
 *
 * panel edge → button hpad → node-cell (base-pad + depth×indent) → chevron → icon → text
 */

import type { CSSProperties } from "react"

export const REVIEW_TREE_HPAD_PX = 16
export const REVIEW_TREE_BASE_PAD_PX = 16
export const REVIEW_TREE_INDENT_PX = 20
/** Depth-0 chevron distance from the bordered sidebar edge. */
export const REVIEW_TREE_ROOT_INSET_PX = REVIEW_TREE_HPAD_PX + REVIEW_TREE_BASE_PAD_PX

export function reviewTreeNodeCellStyle(depth: number): CSSProperties {
  return {
    ["--review-tree-depth" as string]: Math.max(0, depth),
    ["--review-tree-base-pad" as string]: `${REVIEW_TREE_BASE_PAD_PX}px`,
    ["--review-tree-indent" as string]: `${REVIEW_TREE_INDENT_PX}px`,
  }
}
