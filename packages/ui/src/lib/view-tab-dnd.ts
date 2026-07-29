/**
 * Pure view-tab reorder math — no React, no DOM event wiring.
 *
 * Visual model (Chrome-like, layout-stable):
 * 1. Source stays in flex flow (invisible) — grab never reflows the strip.
 * 2. Only tabs between home and drop translate by ±(width + gap).
 * 3. Drop slot from float coverage (≥ half a peer’s width).
 */

export interface ViewTabDragState {
  viewId: string
  startX: number
  startY: number
  pointerId: number
  hasMoved: boolean
  /** Tab width at grab (source keeps this seat in layout). */
  widthPx: number
  /** Pointer offset from the tab’s left edge (keeps float under the grab). */
  grabOffsetX: number
  /** Tab top in client coordinates — float locks to this Y (not strip top). */
  floatTop: number
  /** Full-list index of the dragged tab (home seat). */
  homeSlot: number
  /** Frozen strip bounds for float clamping. */
  peerStrip: PeerStripMetrics | null
}

export interface PeerStripMetrics {
  /** Flex gap between tabs (px). */
  gapPx: number
  /**
   * Max strip-local left for the drag float so it cannot pass the `+`.
   */
  maxFloatLeftPx: number
  /** Min strip-local left (content start / padding). */
  minFloatLeftPx: number
}

export type PeerLayoutRect = {
  left: number
  width: number
  /** Index in the full views list (DOM order). */
  fullIndex: number
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
 * Insert slot from float coverage of peers (remaining list order — source omitted).
 * A peer only counts once the float covers ≥ half of its width. Then the
 * insert hole moves to the far side of that peer. If nothing is half-covered,
 * keep `currentSlot`.
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

  if (bestIndex < currentSlot) return bestIndex
  return bestIndex + 1
}

/**
 * Remaining-based insert slot → `reorderViews` toIndex.
 * With source still seated at `homeSlot`, this equals the final full-list index.
 */
export function toIndexFromRemainingSlot(remainingSlot: number): number {
  return Math.max(0, remainingSlot)
}

/**
 * Displace only tabs between home and drop. At home, every peer slide is 0 —
 * grab does not move the strip. `peerIndex` / slots are full-list indices.
 */
export function peerSlidePx(
  peerIndex: number,
  homeSlot: number,
  dropSlot: number,
  dragWidthPx: number,
  gapPx: number,
): number {
  const delta = dragWidthPx + gapPx
  if (dropSlot === homeSlot) return 0
  if (homeSlot < dropSlot) {
    if (peerIndex > homeSlot && peerIndex <= dropSlot) return -delta
    return 0
  }
  if (peerIndex >= dropSlot && peerIndex < homeSlot) return delta
  return 0
}

/**
 * Capture strip bounds for float clamping (source stays in flow).
 */
export function capturePeerStrip(
  container: HTMLElement | null,
  _dragViewId: string,
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

/**
 * Non-dragging peer layout in client X (ignores CSS transforms — use offsetLeft).
 */
export function peerLayoutRectsClient(container: HTMLElement | null): PeerLayoutRect[] {
  if (!container) return []
  const stripLeft = container.getBoundingClientRect().left
  const scrollLeft = container.scrollLeft
  const tabs = [...container.querySelectorAll<HTMLElement>("[data-view-id]")]
  const out: PeerLayoutRect[] = []
  for (let i = 0; i < tabs.length; i++) {
    const el = tabs[i]!
    if (el.hasAttribute("data-view-dragging")) continue
    out.push({
      left: stripLeft + el.offsetLeft - scrollLeft,
      width: el.offsetWidth,
      fullIndex: i,
    })
  }
  return out
}

/** Visual peer rects = resting layout + home→drop displacement. */
export function visualPeerRectsClient(
  layout: ReadonlyArray<PeerLayoutRect>,
  homeSlot: number,
  dropSlot: number,
  dragWidthPx: number,
  gapPx: number,
): Array<{ left: number; width: number }> {
  return layout.map((peer) => ({
    left: peer.left + peerSlidePx(peer.fullIndex, homeSlot, dropSlot, dragWidthPx, gapPx),
    width: peer.width,
  }))
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
