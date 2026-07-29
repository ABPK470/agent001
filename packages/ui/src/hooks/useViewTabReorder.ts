/**
 * Flat peer handlers for view-tab drag reorder (Chrome-like).
 * Transient drag state lives in a ref — no nested listener allocations.
 *
 * Grab is seamless: an in-flow placeholder keeps the hole; peers never pack
 * or translate on drag start. Drop slot follows 50% float coverage of peers.
 * Once dragging, window owns move/up so remounting the capture host cannot
 * abort the gesture.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { flushSync } from "react-dom"
import {
  capturePeerStrip,
  clampFloatLeft,
  dropSlotFromFloatCoverage,
  markDragMoved,
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
  /** Match resting tab chrome (close control present when >1 views). */
  showClose: boolean
}

export function useViewTabReorder(
  tabsRef: RefObject<HTMLElement | null>,
  editingId: string | null,
) {
  const dragRef = useRef<ViewTabDragState | null>(null)
  const dropSlotRef = useRef(0)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  /** Remaining-list insert slot while dragging (including home). */
  const [dropSlot, setDropSlot] = useState<number | null>(null)
  const [dragWidthPx, setDragWidthPx] = useState(96)
  const [float, setFloat] = useState<ViewTabFloat | null>(null)

  function clearDragSession(): void {
    dragRef.current = null
    setDraggingId(null)
    setDropSlot(null)
    setFloat(null)
  }

  function floatLeftFromPointer(drag: ViewTabDragState, clientX: number): number {
    const strip = tabsRef.current
    const stripLeft = strip?.getBoundingClientRect().left ?? 0
    const scrollLeft = strip?.scrollLeft ?? 0
    const rawLeft = clientX - drag.grabOffsetX - stripLeft + scrollLeft
    const bounds = drag.peerStrip
    return bounds
      ? clampFloatLeft(rawLeft, bounds.minFloatLeftPx, bounds.maxFloatLeftPx)
      : rawLeft
  }

  function floatFromPointer(drag: ViewTabDragState, clientX: number): ViewTabFloat {
    const views = useLayoutStore.getState().views
    const view = views.find((item) => item.id === drag.viewId)
    return {
      name: view?.name ?? "",
      widthPx: drag.widthPx,
      left: floatLeftFromPointer(drag, clientX),
      wasActive: useLayoutStore.getState().activeViewId === drag.viewId,
      showClose: views.length > 1,
    }
  }

  function livePeerRects(): Array<{ left: number; width: number }> {
    const strip = tabsRef.current
    if (!strip) return []
    return [...strip.querySelectorAll<HTMLElement>("[data-view-id]:not([data-view-dragging])")].map(
      (el) => {
        const box = el.getBoundingClientRect()
        return { left: box.left, width: box.width }
      },
    )
  }

  function slotFromFloat(drag: ViewTabDragState, clientX: number): number {
    const strip = tabsRef.current
    const stripLeft = strip?.getBoundingClientRect().left ?? 0
    const scrollLeft = strip?.scrollLeft ?? 0
    const left = floatLeftFromPointer(drag, clientX)
    const floatClientLeft = left + stripLeft - scrollLeft
    const slot = dropSlotFromFloatCoverage(
      livePeerRects(),
      floatClientLeft,
      drag.widthPx,
      dropSlotRef.current,
    )
    dropSlotRef.current = slot
    return slot
  }

  function finishDrag(clientX: number): void {
    const drag = dragRef.current
    if (!drag) return

    const slot = drag.hasMoved && drag.peerStrip
      ? slotFromFloat(drag, clientX)
      : drag.homeSlot
    const toIndex = toIndexFromRemainingSlot(slot)
    const fromIndex = useLayoutStore.getState().views.findIndex((view) => view.id === drag.viewId)
    const action = resolveViewTabDrop(drag, toIndex, fromIndex)

    clearDragSession()

    if (action.kind === "reorder") {
      useLayoutStore.getState().reorderViews(action.viewId, action.toIndex)
    }
  }

  function tickDrag(clientX: number): void {
    const drag = dragRef.current
    if (!drag?.hasMoved) return
    setDropSlot(slotFromFloat(drag, clientX))
    setFloat(floatFromPointer(drag, clientX))
  }

  // Window owns the gesture after threshold so strip remounts cannot abort it.
  useEffect(() => {
    if (!draggingId) return

    function onWindowPointerMove(event: PointerEvent) {
      tickDrag(event.clientX)
    }

    function onWindowPointerUp(event: PointerEvent) {
      finishDrag(event.clientX)
    }

    function onWindowPointerCancel() {
      clearDragSession()
    }

    window.addEventListener("pointermove", onWindowPointerMove)
    window.addEventListener("pointerup", onWindowPointerUp)
    window.addEventListener("pointercancel", onWindowPointerCancel)
    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove)
      window.removeEventListener("pointerup", onWindowPointerUp)
      window.removeEventListener("pointercancel", onWindowPointerCancel)
    }
  }, [draggingId])

  function onTabPointerDown(viewId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (editingId === viewId || event.button !== 0) return
    if ((event.target as HTMLElement).closest("button, input")) return

    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)

    const { activeViewId, setActiveView, views } = useLayoutStore.getState()
    if (activeViewId !== viewId) {
      flushSync(() => {
        setActiveView(viewId)
      })
    }

    const fromIndex = views.findIndex((view) => view.id === viewId)
    const rect = target.getBoundingClientRect()
    const homeSlot = Math.max(0, fromIndex)
    dropSlotRef.current = homeSlot
    dragRef.current = {
      viewId,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      hasMoved: false,
      widthPx: target.offsetWidth,
      grabOffsetX: event.clientX - rect.left,
      floatTop: rect.top,
      homeSlot,
      peerStrip: null,
    }
  }

  function onTabPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.hasMoved) return

    const moved = markDragMoved(drag, event.clientX, event.clientY)
    if (!moved) return

    drag.peerStrip = capturePeerStrip(tabsRef.current, drag.viewId, drag.widthPx)
    setDragWidthPx(drag.widthPx)
    dropSlotRef.current = drag.homeSlot
    setDropSlot(drag.homeSlot)
    setFloat(floatFromPointer(drag, event.clientX))
    setDraggingId(drag.viewId)
  }

  function onTabPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    // Pre-threshold click — activate already happened on down; just clear.
    if (!drag.hasMoved) {
      clearDragSession()
      try {
        event.currentTarget.releasePointerCapture(drag.pointerId)
      } catch (err: unknown) { console.error("[mia]", err) }
      return
    }
    // Active drag finishes via window pointerup.
  }

  function onTabPointerCancel(): void {
    if (!dragRef.current) return
    if (dragRef.current.hasMoved) return
    clearDragSession()
  }

  function onTabLostPointerCapture(): void {
    // After threshold, window listeners own the gesture — ignore capture loss
    // from remounting the strip around the placeholder.
    if (!dragRef.current || dragRef.current.hasMoved) return
    clearDragSession()
  }

  return {
    draggingId,
    dropSlot,
    dragWidthPx,
    float,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
    onTabPointerCancel,
    onTabLostPointerCapture,
  }
}
