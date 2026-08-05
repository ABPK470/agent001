/**
 * VirtualList inspect anchoring — lock the visible row by index + offset
 * inside that row, not raw global scrollTop (survives async remasure).
 */

export type VirtualListScrollAnchor = {
  index: number
  /** Pixels from the item's start to the viewport top. */
  offsetInItem: number
}

export type VirtualRowOffset = {
  index: number
  start: number
  size: number
}

/** Pick the row under the viewport top (or the last row that starts above it). */
export function captureVirtualScrollAnchor(
  scrollTop: number,
  rows: readonly VirtualRowOffset[],
): VirtualListScrollAnchor | null {
  if (rows.length === 0) return null
  let chosen = rows[0]!
  for (const row of rows) {
    if (row.start <= scrollTop) {
      chosen = row
      continue
    }
    break
  }
  return {
    index: chosen.index,
    offsetInItem: Math.max(0, scrollTop - chosen.start),
  }
}

/** ScrollTop that puts `anchor` back under the viewport top after remasure. */
export function scrollTopForVirtualAnchor(
  anchor: VirtualListScrollAnchor,
  itemStart: number | null | undefined,
): number | null {
  if (itemStart == null || !Number.isFinite(itemStart)) return null
  return Math.max(0, itemStart + anchor.offsetInItem)
}
