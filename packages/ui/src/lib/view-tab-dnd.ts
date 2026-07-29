/**
 * Pure view-tab reorder math — no React, no DOM event wiring.
 *
 * Model (seamless grab):
 * 1. Source leaves flex flow (capture host only). An in-flow placeholder of the
 *    same width sits at `dropSlot` — peers do not pack/translate on grab.
 * 2. Drop slot updates when the float covers ≥ half of a peer’s width; then
 *    insert before/after that peer from float center vs peer center.
 * 3. Until any peer is half-covered, the slot stays put (no jitter on grab).
 */

export interface ViewTabDragState {
  viewId: string
  startX: number
  startY: number
  pointerId: number
  hasMoved: boolean
  /** Tab width captured before the source leaves flow (placeholder sizing). */
  widthPx: number
  /** Pointer offset from the tab’s left edge (keeps float under the grab). */
  grabOffsetX: number
  /** Tab top in client coordinates — float locks to this Y (not strip top). */
  floatTop: number
  /** Remaining-list insert slot at drag start (home gap). */
  homeSlot: number
  /** Frozen strip bounds for float clamping. */
  peerStrip: PeerStripMetrics | null
}

export interface PeerStripMetrics {
  /** Flex gap between tabs (px). */
  gapPx: number
  /**
   * Max strip-local left for the drag float so it cannot pass the `+`
   * (captured before source leaves flow).
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

/** Horizontal overlap of [a0, a0+aW) with [b0, b0+bW). */
export function overlapWidthPx(
  aLeft: number,
  aWidth: number,
  bLeft: number,
  bWidth: number,
): number {
  const left = Math.max(aLeft, bLeft)
  const right = Math.min(aLeft + aWidth, bLeft + bWidth)
  return Math.max(0, right - left)
}

/**
 * Insert slot from float coverage of live peers (remaining list order).
 * A peer only counts once the float covers ≥ half of its width. Then the
 * insert hole moves to the far side of that peer (left peers → before them,
 * right peers → after them). If nothing is half-covered, keep `currentSlot`.
 */
export function dropSlotFromFloatCoverage(
  peerRects: ReadonlyArray<{ left: number; width: number }>,
  floatLeft: number,
  floatWidth: number,
  currentSlot: number,
): number {
  if (peerRects.length === 0) return 0

  let bestIndex = -1
  let bestCovered = 0
  for (let i = 0; i < peerRects.length; i++) {
    const peer = peerRects[i]!
    if (peer.width <= 0) continue
    const covered = overlapWidthPx(floatLeft, floatWidth, peer.left, peer.width)
    if (covered < peer.width / 2) continue
    if (covered > bestCovered) {
      bestCovered = covered
      bestIndex = i
    }
  }
  if (bestIndex < 0) {
    return Math.max(0, Math.min(currentSlot, peerRects.length))
  }

  // Move the hole to the far side of the covered peer (relative to the hole).
  if (bestIndex < currentSlot) return bestIndex
  return bestIndex + 1
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
 * Capture strip bounds before the source leaves flow.
 * Peer hit-testing uses live rects while dragging (placeholder keeps layout).
 */
export function capturePeerStrip(
  container: HTMLElement | null,
  dragViewId: string,
  dragWidthPx: number,
): PeerStripMetrics | null {
  if (!container) return null
  const styles = getComputedStyle(container)
  const gapPx = parseFloat(styles.columnGap || styles.gap || "4") || 4
  const padLeft = parseFloat(styles.paddingLeft || "0") || 0
  const addBtn = container.querySelector<HTMLElement>(".view-tab-add")
  const maxFloatLeftPx = addBtn
    ? Math.max(padLeft, addBtn.offsetLeft - dragWidthPx)
    : padLeft
  return {
    gapPx,
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
