/**
 * Pure view-tab reorder math — no React, no DOM event wiring.
 * UI handlers stay flat peers; they call into this module.
 */

export interface ViewTabDragState {
  viewId: string
  startX: number
  startY: number
  pointerId: number
  hasMoved: boolean
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

/** Map an insertion slot to the `toIndex` consumed by `reorderViews`. */
export function toIndexFromInsertSlot(fromIndex: number, insertSlot: number): number {
  if (fromIndex < 0) return Math.max(0, insertSlot)
  if (insertSlot > fromIndex) return insertSlot - 1
  return insertSlot
}

/** True when the insert slot would actually move the dragged tab. */
export function insertSlotWouldMove(fromIndex: number, insertSlot: number): boolean {
  if (fromIndex < 0) return false
  return insertSlot !== fromIndex && insertSlot !== fromIndex + 1
}

export function readTabRects(container: HTMLElement | null): Array<{ left: number; width: number }> {
  if (!container) return []
  return [...container.querySelectorAll<HTMLElement>("[data-view-id]")].map((el) => {
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
