/**
 * Flat peer handlers for view-tab drag reorder.
 * Transient drag state lives in a ref — no nested listener allocations.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import {
  insertSlotWouldMove,
  markDragMoved,
  readTabRects,
  resolveViewTabDrop,
  tabInsertSlotFromClientX,
  toIndexFromInsertSlot,
  type ViewTabDragState,
} from "../lib/view-tab-dnd"
import { useLayoutStore } from "../state/layout-store"

export function useViewTabReorder(
  tabsRef: RefObject<HTMLElement | null>,
  editingId: string | null,
) {
  const dragRef = useRef<ViewTabDragState | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** Insertion gap 0..n while dragging; null when idle or click-without-drag. */
  const [dropSlot, setDropSlot] = useState<number | null>(null)

  function clearDragSession(): void {
    dragRef.current = null
    setDraggingId(null)
    setDropSlot(null)
  }

  function slotFromPointer(clientX: number): number {
    return tabInsertSlotFromClientX(readTabRects(tabsRef.current), clientX)
  }

  function onTabPointerDown(viewId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (editingId === viewId || event.button !== 0) return
    if ((event.target as HTMLElement).closest("button, input")) return

    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    dragRef.current = {
      viewId,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      hasMoved: false,
    }
    // Do not enter drag chrome until the press clears the move threshold —
    // otherwise a normal click feels like a reorder gesture.
  }

  function onTabPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return

    const alreadyDragging = drag.hasMoved
    const moved = markDragMoved(drag, event.clientX, event.clientY)
    if (!moved) return

    // Enter drag chrome only after the threshold clears (not on pointer-down).
    if (!alreadyDragging) setDraggingId(drag.viewId)

    const views = useLayoutStore.getState().views
    const fromIndex = views.findIndex((view) => view.id === drag.viewId)
    const slot = slotFromPointer(event.clientX)
    setDropSlot(insertSlotWouldMove(fromIndex, slot) ? slot : null)
  }

  function onTabPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return

    // Clear before release so lostpointercapture is a no-op (intentional end).
    dragRef.current = null
    setDraggingId(null)
    setDropSlot(null)

    try {
      event.currentTarget.releasePointerCapture(drag.pointerId)
    } catch {
      // Capture may already be gone after cancel.
    }

    const { views, reorderViews, setActiveView } = useLayoutStore.getState()
    const fromIndex = views.findIndex((view) => view.id === drag.viewId)
    const slot = slotFromPointer(event.clientX)
    const toIndex = toIndexFromInsertSlot(fromIndex, slot)
    const action = resolveViewTabDrop(drag, toIndex, fromIndex)

    if (action.kind === "reorder") {
      reorderViews(action.viewId, action.toIndex)
    } else {
      setActiveView(action.viewId)
    }
  }

  function onTabPointerCancel(): void {
    if (!dragRef.current) return
    clearDragSession()
  }

  /** Browser/OS stole the capture — abort without activating/reordering. */
  function onTabLostPointerCapture(): void {
    if (!dragRef.current) return
    clearDragSession()
  }

  return {
    draggingId,
    dropSlot,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
    onTabPointerCancel,
    onTabLostPointerCapture,
  }
}
