/**
 * Pipelines left tree — which day cap should pin while scrolling.
 * VirtualList absolute rows break CSS sticky; pin is a sibling overlay.
 */

import type { VirtualListScrollAnchor } from "./virtual-list-anchor"
import type { OperationFlatRow } from "./operation-flat-rows"

export type PinnedOperationDay = {
  key: string
  label: string
  count: number
}

/**
 * Day owning the row under the viewport top. Null when that day header is
 * still flush at the top (in-flow is enough — no double paint).
 */
export function resolvePinnedOperationDay(
  rows: readonly OperationFlatRow[],
  anchor: VirtualListScrollAnchor | null,
): PinnedOperationDay | null {
  if (!anchor || anchor.index < 0 || anchor.index >= rows.length) return null
  const top = rows[anchor.index]
  if (!top) return null
  if (top.type === "day" && anchor.offsetInItem <= 1) return null

  const from = top.type === "day" ? anchor.index : anchor.index
  for (let i = from; i >= 0; i--) {
    const row = rows[i]
    if (row?.type === "day") {
      return { key: row.key, label: row.label, count: row.count }
    }
  }
  return null
}
