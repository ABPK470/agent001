/**
 * Flat peer handlers for view-tab drag reorder.
 * Transient drag state lives in a ref — no nested listener allocations.
 *
 * After the move threshold: source collapses out of flex flow (still mounted
 * for pointer capture), peers close, and an in-flow ghost opens the insert
 * gap. Hit-testing uses frozen peer metrics so the ghost cannot jitter slots.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import {
  capturePeerStrip,
  markDragMoved,
  remainingSlotFromPointer,
  resolveViewTabDrop,
  toIndexFromRemainingSlot,
  type ViewTabDragState,
} from "../lib/view-tab-dnd"
import { useLayoutStore } from "../state/layout-store"

export function useViewTabReorder(
  tabsRef: RefObject<HTMLElement | null>,
  editingId: string | null,
) {
  const dragRef = useRef<ViewTabDragState | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** Remaining-based insert slot while dragging (including home). */
  const [dropSlot, setDropSlot] = useState<number | null>(null)
  const [dragWidthPx, setDragWidthPx] = useState(96)

  function clearDragSession(): void {
    dragRef.current = null
    setDraggingId(null)
    setDropSlot(null)
  }

  function slotFromPointer(clientX: number): number {
    const drag = dragRef.current
    return remainingSlotFromPointer(drag?.peerStrip ?? null, clientX)
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
      widthPx: target.offsetWidth,
      peerStrip: null,
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
    if (!alreadyDragging) {
      const views = useLayoutStore.getState().views
      const fromIndex = views.findIndex((view) => view.id === drag.viewId)
      // Freeze peer geometry before collapse/ghost shift the live DOM.
      drag.peerStrip = capturePeerStrip(tabsRef.current, drag.viewId)
      setDragWidthPx(drag.widthPx)
      setDraggingId(drag.viewId)
      // Start at home so the first paint replaces the source with the ghost
      // (same width) — no empty closed gap, no slot flicker under the pointer.
      setDropSlot(Math.max(0, fromIndex))
      return
    }

    setDropSlot(slotFromPointer(event.clientX))
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
    } catch (err: unknown) { console.error("[mia]", err) }

    const { views, reorderViews, setActiveView } = useLayoutStore.getState()
    const fromIndex = views.findIndex((view) => view.id === drag.viewId)
    // peerStrip still on local `drag` after we nulled dragRef.
    const slot = remainingSlotFromPointer(drag.peerStrip, event.clientX)
    const toIndex = toIndexFromRemainingSlot(slot)
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
    dragWidthPx,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
    onTabPointerCancel,
    onTabLostPointerCapture,
  }
}
