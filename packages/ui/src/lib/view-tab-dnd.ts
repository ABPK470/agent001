/**
 * Pure view-tab reorder math — no React, no DOM event wiring.
 * UI handlers stay flat peers; they call into this module.
 *
 * While dragging, the source tab collapses out of the strip and hit-testing
 * uses peer tabs only (remaining). Insert slots are 0..peers.length.
 */

export interface ViewTabDragState {
  viewId: string
  startX: number
  startY: number
  pointerId: number
  hasMoved: boolean
  /** Tab width captured before the source collapses (ghost sizing). */
  widthPx: number
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

/**
 * Remaining-based insert slot → `reorderViews` toIndex.
 * Peers are the list with the dragged tab removed; inserting at `slot`
 * is exactly the final index of the moved tab.
 */
export function toIndexFromRemainingSlot(remainingSlot: number): number {
  return Math.max(0, remainingSlot)
}

/**
 * Home gap among peers after the source collapses equals `fromIndex`.
 * Only then is the strip a closed peer row with no ghost.
 */
export function remainingSlotWouldMove(fromIndex: number, remainingSlot: number): boolean {
  if (fromIndex < 0) return false
  return remainingSlot !== fromIndex
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

export function readTabRects(container: HTMLElement | null): Array<{ left: number; width: number }> {
  if (!container) return []
  // Skip the collapsed drag source — hit-test peers only.
  return [...container.querySelectorAll<HTMLElement>("[data-view-id]:not([data-view-dragging])")].map((el) => {
    const rect = el.getBoundingClientRect()
    return { left: rect.left, width: rect.width }
  })
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
