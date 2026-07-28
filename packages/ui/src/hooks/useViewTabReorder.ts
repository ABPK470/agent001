/**
 * Flat peer handlers for view-tab drag reorder (Chrome-like).
 * Transient drag state lives in a ref — no nested listener allocations.
 *
 * After the move threshold: source collapses out of flex flow (still mounted
 * for pointer capture), peers slide via transform to open the insert gap, and
 * a strip-local tab preview follows the pointer on the bar (same silhouette).
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import {
  capturePeerStrip,
  clampFloatLeft,
  markDragMoved,
  remainingSlotFromPointer,
  resolveViewTabDrop,
  toIndexFromRemainingSlot,
  type ViewTabDragState,
} from "../lib/view-tab-dnd"
import { useLayoutStore } from "../state/layout-store"

export type ViewTabFloat = {
  name: string
  widthPx: number
  /** Left offset inside the tab strip (absolute). */
  left: number
  wasActive: boolean
}

export function useViewTabReorder(
  tabsRef: RefObject<HTMLElement | null>,
  editingId: string | null,
) {
  const dragRef = useRef<ViewTabDragState | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** Remaining-based insert slot while dragging (including home). */
  const [dropSlot, setDropSlot] = useState<number | null>(null)
  const [dragWidthPx, setDragWidthPx] = useState(96)
  const [gapPx, setGapPx] = useState(2)
  const [float, setFloat] = useState<ViewTabFloat | null>(null)

  function clearDragSession(): void {
    dragRef.current = null
    setDraggingId(null)
    setDropSlot(null)
    setFloat(null)
  }

  function slotFromPointer(clientX: number): number {
    const drag = dragRef.current
    return remainingSlotFromPointer(drag?.peerStrip ?? null, clientX)
  }

  function floatFromPointer(drag: ViewTabDragState, clientX: number): ViewTabFloat {
    const views = useLayoutStore.getState().views
    const view = views.find((item) => item.id === drag.viewId)
    const strip = tabsRef.current
    const stripLeft = strip?.getBoundingClientRect().left ?? 0
    const scrollLeft = strip?.scrollLeft ?? 0
    const rawLeft = clientX - drag.grabOffsetX - stripLeft + scrollLeft
    const bounds = drag.peerStrip
    const left = bounds
      ? clampFloatLeft(rawLeft, bounds.minFloatLeftPx, bounds.maxFloatLeftPx)
      : rawLeft
    return {
      name: view?.name ?? "",
      widthPx: drag.widthPx,
      left,
      wasActive: useLayoutStore.getState().activeViewId === drag.viewId,
    }
  }

  function onTabPointerDown(viewId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (editingId === viewId || event.button !== 0) return
    if ((event.target as HTMLElement).closest("button, input")) return

    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const rect = target.getBoundingClientRect()

    dragRef.current = {
      viewId,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      hasMoved: false,
      widthPx: target.offsetWidth,
      grabOffsetX: event.clientX - rect.left,
      floatTop: rect.top,
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
      // Freeze peer geometry before collapse/slide shift the live DOM.
      drag.peerStrip = capturePeerStrip(tabsRef.current, drag.viewId, drag.widthPx)
      setDragWidthPx(drag.widthPx)
      setGapPx(drag.peerStrip?.gapPx ?? 2)
      setDraggingId(drag.viewId)
      // Start at home so peers open the home gap under the moving tab.
      setDropSlot(Math.max(0, fromIndex))
      setFloat(floatFromPointer(drag, event.clientX))
      return
    }

    setDropSlot(slotFromPointer(event.clientX))
    setFloat(floatFromPointer(drag, event.clientX))
  }

  function onTabPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return

    // Clear before release so lostpointercapture is a no-op (intentional end).
    dragRef.current = null
    setDraggingId(null)
    setDropSlot(null)
    setFloat(null)

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
    gapPx,
    float,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
    onTabPointerCancel,
    onTabLostPointerCapture,
  }
}
