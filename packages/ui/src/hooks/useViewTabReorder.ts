/**
 * Flat peer handlers for view-tab drag reorder.
 * Transient drag state lives in a ref — no nested listener allocations.
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import {
  markDragMoved,
  readTabRects,
  resolveViewTabDrop,
  tabIndexFromClientX,
  type ViewTabDragState,
} from "../lib/view-tab-dnd"
import { useLayoutStore } from "../state/layout-store"

export function useViewTabReorder(
  tabsRef: RefObject<HTMLElement | null>,
  editingId: string | null,
) {
  const dragRef = useRef<ViewTabDragState | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  function indexFromPointer(clientX: number): number {
    return tabIndexFromClientX(readTabRects(tabsRef.current), clientX)
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

    const views = useLayoutStore.getState().views
    setDraggingId(viewId)
    setDropIndex(views.findIndex((view) => view.id === viewId))
  }

  function onTabPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return

    markDragMoved(drag, event.clientX, event.clientY)
    setDropIndex(indexFromPointer(event.clientX))
  }

  function onTabPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return

    event.currentTarget.releasePointerCapture(drag.pointerId)

    const { views, reorderViews, setActiveView } = useLayoutStore.getState()
    const toIndex = indexFromPointer(event.clientX)
    const fromIndex = views.findIndex((view) => view.id === drag.viewId)
    const action = resolveViewTabDrop(drag, toIndex, fromIndex)

    if (action.kind === "reorder") {
      reorderViews(action.viewId, action.toIndex)
    } else {
      setActiveView(action.viewId)
    }

    dragRef.current = null
    setDraggingId(null)
    setDropIndex(null)
  }

  return {
    draggingId,
    dropIndex,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
  }
}
