/**
 * Shared curved nest — Threads / Trace / Event Stream / Pipelines.
 *
 * Contract (hard):
 *   <ReviewTree>
 *     <ReviewTreeItem>…header / row…</ReviewTreeItem>
 *     <ReviewTreeItem>
 *       …header…
 *       <ReviewTree>…deeper peers…</ReviewTree>
 *     </ReviewTreeItem>
 *   </ReviewTree>
 *
 * - Only *direct* ReviewTreeItem children of a ReviewTree get elbows.
 * - Put prose / error boxes *inside* an item (or as their own item) — never
 *   as bare siblings, or the stem breaks.
 * - Deeper nests (`<ReviewTree>` / LogNest) live *inside* the parent item —
 *   never as a peer of that item, or the parent stem gaps (Pipelines).
 * - Nest flush with the parent row (no extra pl-*). Stem sits at
 *   `--review-tree-x` = center of `.review-chevron-slot` (Threads geometry).
 */

import type { JSX, ReactNode } from "react"

export function ReviewTree({
  children,
  className = "",
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={["review-tree", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  )
}

export function ReviewTreeItem({
  children,
  className = "",
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={["review-tree__item", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  )
}
