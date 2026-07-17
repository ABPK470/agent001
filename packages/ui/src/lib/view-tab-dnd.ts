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
  if (tabRects.length === 0) return 0
  for (let i = 0; i < tabRects.length; i++) {
    const rect = tabRects[i]!
    if (clientX < rect.left + rect.width / 2) return i
  }
  return tabRects.length - 1
}

export function readTabRects(container: HTMLElement | null): Array<{ left: number; width: number }> {
  if (!container) return []
  return [...container.querySelectorAll<HTMLElement>("[data-view-id]")].map((el) => {
    const rect = el.getBoundingClientRect()
    return { left: rect.left, width: rect.width }
  })
}

export function markDragMoved(
  drag: ViewTabDragState,
  clientX: number,
  clientY: number,
  thresholdPx = 4,
): boolean {
  if (drag.hasMoved) return true
  const moved = Math.abs(clientX - drag.startX) + Math.abs(clientY - drag.startY) > thresholdPx
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
