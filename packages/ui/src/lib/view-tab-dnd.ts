/**
 * Pure view-tab reorder math — no React, no DOM event wiring.
 * UI handlers stay flat peers; they call into this module.
 *
 * While dragging, hit-testing uses a frozen peer strip (captured at drag
 * start) so midpoints stay stable. Peers slide with translateX to open the
 * insert gap (Chrome-like); a floating tab follows the pointer.
 */

export interface ViewTabDragState {
  viewId: string
  startX: number
  startY: number
  pointerId: number
  hasMoved: boolean
  /** Tab width captured before the source collapses (float + gap sizing). */
  widthPx: number
  /** Pointer offset from the tab’s left edge (keeps float under the grab). */
  grabOffsetX: number
  /** Tab top in client coordinates — float locks to this Y (not strip top). */
  floatTop: number
  /** Frozen peer geometry for jitter-free hit-testing while peers slide. */
  peerStrip: PeerStripMetrics | null
}

export interface PeerStripMetrics {
  /** Content-box left of the tab strip (client coordinates). */
  originLeft: number
  /** Top of the tab strip (client coordinates) — float Y lock. */
  originTop: number
  /** Flex gap between tabs (px). */
  gapPx: number
  /** Peer widths in order, source excluded. */
  peerWidths: readonly number[]
  /**
   * Max strip-local left for the drag float so it cannot pass the `+`
   * (captured before source collapse).
   */
  maxFloatLeftPx: number
  /** Min strip-local left (content start / padding). */
  minFloatLeftPx: number
}

export type ViewTabDropAction =
  | { kind: "reorder"; viewId: string; toIndex: number }
  | { kind: "activate"; viewId: string }

/** Clamp the drag float so it stays left of the `+` (and on the strip). */
export function clampFloatLeft(left: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, left))
}

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

/** Lay out peer rects from frozen strip metrics (ignores live transforms). */
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
 */
export function fullIndexFromRemainingSlot(fromIndex: number, remainingSlot: number): number {
  if (fromIndex < 0) return Math.max(0, remainingSlot)
  if (remainingSlot <= fromIndex) return remainingSlot
  return remainingSlot + 1
}

/**
 * Chrome-like peer slide: remaining peer at index `peerIndex` shifts right
 * when the insert gap opens at or before it.
 */
export function peerSlidePx(
  peerIndex: number,
  dropSlot: number,
  dragWidthPx: number,
  gapPx: number,
): number {
  if (peerIndex < dropSlot) return 0
  return dragWidthPx + gapPx
}

/**
 * Keep the trailing `+` button at the end of the visual tab row while
 * dragging. Source collapse pulls it left in layout; this restores it so the
 * open gap never sits under / past the add control.
 */
export function addButtonSlidePx(dragWidthPx: number, gapPx: number): number {
  return dragWidthPx + gapPx
}

/**
 * Capture peer strip metrics before the source collapses.
 * Live DOM midpoints must not be used after peers start sliding.
 */
export function capturePeerStrip(
  container: HTMLElement | null,
  dragViewId: string,
  dragWidthPx: number,
): PeerStripMetrics | null {
  if (!container) return null
  const tabs = [...container.querySelectorAll<HTMLElement>("[data-view-id]")]
  const peers = tabs.filter((el) => el.dataset.viewId !== dragViewId)
  const styles = getComputedStyle(container)
  const gapPx = parseFloat(styles.columnGap || styles.gap || "4") || 4
  const padLeft = parseFloat(styles.paddingLeft || "0") || 0
  const rect = container.getBoundingClientRect()
  const addBtn = container.querySelector<HTMLElement>(".view-tab-add")
  // Before collapse: `+` is still after the full tab row. Float right edge
  // must not cross its left edge (tabs cannot pass the add control).
  const maxFloatLeftPx = addBtn
    ? Math.max(padLeft, addBtn.offsetLeft - dragWidthPx)
    : padLeft
  return {
    originLeft: rect.left + padLeft,
    originTop: rect.top,
    gapPx,
    peerWidths: peers.map((el) => el.offsetWidth),
    maxFloatLeftPx,
    minFloatLeftPx: padLeft,
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
