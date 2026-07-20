/**
 * Pure view-tab reorder math — no React, no DOM event wiring.
 * UI handlers stay flat peers; they call into this module.
 *
 * While dragging, hit-testing uses a frozen peer strip (captured at drag
 * start) so the in-flow ghost cannot shift midpoints and jitter the slot.
 */

export interface ViewTabDragState {
  viewId: string
  startX: number
  startY: number
  pointerId: number
  hasMoved: boolean
  /** Tab width captured before the source collapses (ghost sizing). */
  widthPx: number
  /** Frozen peer geometry for jitter-free hit-testing while the ghost is in flow. */
  peerStrip: PeerStripMetrics | null
}

export interface PeerStripMetrics {
  /** Content-box left of the tab strip (client coordinates). */
  originLeft: number
  /** Flex gap between tabs (px). */
  gapPx: number
  /** Peer widths in order, source excluded. */
  peerWidths: readonly number[]
}

export type ViewTabDropAction =
  | { kind: "reorder"; viewId: string; toIndex: number }
  | { kind: "activate"; viewId: string }

/** Which tab index a pointer X maps to (midpoint rule). */
export function tabIndexFromClientX(
  tabRects: ReadonlyArray<{ left: number; width: number }>,
  clientX: number,
): number {
  const slot = tabInsertSlotFromClientX(tabRects, clientX)
  if (tabRects.length === 0) return 0
  return Math.min(slot, tabRects.length - 1)
}

/**
 * Insertion slot 0..n — gap before tab `i`, or `n` after the last tab.
 * Midpoint rule: left half of a tab → insert before it.
 */
export function tabInsertSlotFromClientX(
  tabRects: ReadonlyArray<{ left: number; width: number }>,
  clientX: number,
): number {
  if (tabRects.length === 0) return 0
  for (let i = 0; i < tabRects.length; i++) {
    const rect = tabRects[i]!
    if (clientX < rect.left + rect.width / 2) return i
  }
  return tabRects.length
}

/** Lay out peer rects from frozen strip metrics (ignores the live ghost). */
export function syntheticPeerRects(
  strip: PeerStripMetrics,
): Array<{ left: number; width: number }> {
  let left = strip.originLeft
  return strip.peerWidths.map((width) => {
    const rect = { left, width }
    left += width + strip.gapPx
    return rect
  })
}

export function remainingSlotFromPointer(
  strip: PeerStripMetrics | null,
  clientX: number,
): number {
  if (!strip) return 0
  return tabInsertSlotFromClientX(syntheticPeerRects(strip), clientX)
}

/**
 * Remaining-based insert slot → `reorderViews` toIndex.
 * Peers are the list with the dragged tab removed; inserting at `slot`
 * is exactly the final index of the moved tab.
 */
export function toIndexFromRemainingSlot(remainingSlot: number): number {
  return Math.max(0, remainingSlot)
}

/**
 * Map a remaining-based insert slot onto an index in the full views array
 * (where the collapsed source still occupies its original index).
 * Used to place the in-flow ghost among full-list children.
 */
export function fullIndexFromRemainingSlot(fromIndex: number, remainingSlot: number): number {
  if (fromIndex < 0) return Math.max(0, remainingSlot)
  if (remainingSlot <= fromIndex) return remainingSlot
  return remainingSlot + 1
}

/**
 * Capture peer strip metrics before the source collapses.
 * Live DOM midpoints must not be used after the ghost enters the flow.
 */
export function capturePeerStrip(
  container: HTMLElement | null,
  dragViewId: string,
): PeerStripMetrics | null {
  if (!container) return null
  const tabs = [...container.querySelectorAll<HTMLElement>("[data-view-id]")]
  const peers = tabs.filter((el) => el.dataset.viewId !== dragViewId)
  const styles = getComputedStyle(container)
  const gapPx = parseFloat(styles.columnGap || styles.gap || "4") || 4
  const padLeft = parseFloat(styles.paddingLeft || "0") || 0
  return {
    originLeft: container.getBoundingClientRect().left + padLeft,
    gapPx,
    peerWidths: peers.map((el) => el.offsetWidth),
  }
}

/** Distance before a press becomes a reorder drag (keeps clicks as activate). */
export const VIEW_TAB_DRAG_THRESHOLD_PX = 12

export function markDragMoved(
  drag: ViewTabDragState,
  clientX: number,
  clientY: number,
  thresholdPx = VIEW_TAB_DRAG_THRESHOLD_PX,
): boolean {
  if (drag.hasMoved) return true
  const dx = clientX - drag.startX
  const dy = clientY - drag.startY
  const moved = dx * dx + dy * dy > thresholdPx * thresholdPx
  if (moved) drag.hasMoved = true
  return drag.hasMoved
}

/** Resolve pointer-up into reorder vs activate. */
export function resolveViewTabDrop(
  drag: ViewTabDragState,
  toIndex: number,
  fromIndex: number,
): ViewTabDropAction {
  if (drag.hasMoved && fromIndex >= 0 && toIndex !== fromIndex) {
    return { kind: "reorder", viewId: drag.viewId, toIndex }
  }
  return { kind: "activate", viewId: drag.viewId }
}
