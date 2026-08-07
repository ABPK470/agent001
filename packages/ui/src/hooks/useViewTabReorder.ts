/**
 * Flat peer handlers for view-tab drag reorder (Chrome-like).
 * Transient drag state lives in a ref — no nested listener allocations.
 *
 * Grab: source stays in flow (invisible) + float; strip layout does not move.
 * Slot moves: only intervening peers ease via translate. Coverage ≥50%.
 * Window owns move/up after threshold. Strip scroll is locked while dragging.
 */

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { flushSync } from "react-dom"
import {
  capturePeerStrip,
  clampFloatLeft,
  dropSlotFromFloatCoverage,
  markDragMoved,
  peerLayoutRectsClient,
  resolveViewTabDrop,
  toIndexFromRemainingSlot,
  visualPeerRectsClient,
  type ViewTabDragState,
} from "../lib/view-tab-dnd"
import { globalReorderIndex } from "../lib/view-tab-overflow"
import { isZenViewId } from "../lib/zen-session"
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
  const animateArmRef = useRef(0)
  const peerLayoutRef = useRef<ReturnType<typeof peerLayoutRectsClient>>([])
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [homeSlot, setHomeSlot] = useState(0)
  const [dropSlot, setDropSlot] = useState<number | null>(null)
  const [dragWidthPx, setDragWidthPx] = useState(96)
  const [gapPx, setGapPx] = useState(2)
  const [float, setFloat] = useState<ViewTabFloat | null>(null)
  /** After grab settle — ease peer translates on later slot changes. */
  const [slideAnimated, setSlideAnimated] = useState(false)
  /**
   * True from tab pointer-down until session clear — suppresses scrollIntoView
   * so select-on-grab / slight drag cannot shift the strip or `+`.
   */
  const [pointerSession, setPointerSession] = useState(false)

  function clearAnimateArm(): void {
    if (animateArmRef.current) {
      cancelAnimationFrame(animateArmRef.current)
      animateArmRef.current = 0
    }
  }

  function clearDragSession(): void {
    clearAnimateArm()
    dragRef.current = null
    peerLayoutRef.current = []
    setSlideAnimated(false)
    setPointerSession(false)
    setDraggingId(null)
    setDropSlot(null)
    setFloat(null)
  }

  function armSlideAnimation(): void {
    clearAnimateArm()
    animateArmRef.current = requestAnimationFrame(() => {
      animateArmRef.current = requestAnimationFrame(() => {
        animateArmRef.current = 0
        if (dragRef.current?.hasMoved) setSlideAnimated(true)
      })
    })
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

  function slotFromFloat(drag: ViewTabDragState, clientX: number): number {
    const strip = tabsRef.current
    const stripLeft = strip?.getBoundingClientRect().left ?? 0
    const scrollLeft = strip?.scrollLeft ?? 0
    const left = floatLeftFromPointer(drag, clientX)
    const floatClientLeft = left + stripLeft - scrollLeft
    const gap = drag.peerStrip?.gapPx ?? 2
    const layout = peerLayoutRef.current.length > 0
      ? peerLayoutRef.current
      : peerLayoutRectsClient(strip)
    const peers = visualPeerRectsClient(
      layout,
      drag.homeSlot,
      dropSlotRef.current,
      drag.widthPx,
      gap,
    )
    const slot = dropSlotFromFloatCoverage(
      peers,
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
    const stripIds = [...(tabsRef.current?.querySelectorAll<HTMLElement>("[data-view-id]") ?? [])]
      .map((el) => el.dataset.viewId)
      .filter((id): id is string => !!id)
    const toStripIndex = toIndexFromRemainingSlot(slot)
    const allIds = useLayoutStore.getState().views.map((view) => view.id)
    const toIndex = globalReorderIndex(allIds, stripIds, drag.viewId, toStripIndex)
    const fromIndex = allIds.indexOf(drag.viewId)
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

  // Freeze peer layout once the invisible source is marked (transform-free).
  useLayoutEffect(() => {
    if (!draggingId) return
    peerLayoutRef.current = peerLayoutRectsClient(tabsRef.current)
  }, [draggingId])

  // Window owns the gesture after threshold so remounts cannot abort it.
  useEffect(() => {
    if (!draggingId) return

    function onWindowPointerMove(event: PointerEvent) {
      event.preventDefault()
      tickDrag(event.clientX)
    }

    function onWindowPointerUp(event: PointerEvent) {
      finishDrag(event.clientX)
    }

    function onWindowPointerCancel() {
      clearDragSession()
    }

    window.addEventListener("pointermove", onWindowPointerMove, { passive: false })
    window.addEventListener("pointerup", onWindowPointerUp)
    window.addEventListener("pointercancel", onWindowPointerCancel)
    return () => {
      window.removeEventListener("pointermove", onWindowPointerMove)
      window.removeEventListener("pointerup", onWindowPointerUp)
      window.removeEventListener("pointercancel", onWindowPointerCancel)
    }
  }, [draggingId])

  // Freeze strip scroll while dragging — float near edges must not shift the bar.
  useEffect(() => {
    if (!draggingId) return
    const strip = tabsRef.current
    if (!strip) return
    const lockLeft = strip.scrollLeft
    const lockTop = strip.scrollTop
    function onScroll() {
      strip.scrollLeft = lockLeft
      strip.scrollTop = lockTop
    }
    strip.addEventListener("scroll", onScroll)
    return () => strip.removeEventListener("scroll", onScroll)
  }, [draggingId])

  function activateViewIfNeeded(viewId: string): void {
    const { activeViewId, setActiveView } = useLayoutStore.getState()
    if (activeViewId === viewId) return
    flushSync(() => {
      setActiveView(viewId)
    })
  }

  function onTabPointerDown(viewId: string, event: ReactPointerEvent<HTMLDivElement>) {
    if (editingId === viewId || event.button !== 0) return
    if ((event.target as HTMLElement).closest("button, input")) return

    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    event.preventDefault()
    setPointerSession(true)

    // Zen Spaces Call hides the toolbar (chrome-off). Activating on press would
    // unmount the strip mid-gesture — defer Call until a click (no drag) so
    // tabs reorder like regular Spaces.
    if (!isZenViewId(viewId)) {
      activateViewIfNeeded(viewId)
    }

    const stripIds = [...(tabsRef.current?.querySelectorAll<HTMLElement>("[data-view-id]") ?? [])]
      .map((el) => el.dataset.viewId)
      .filter((id): id is string => !!id)
    const home = Math.max(0, stripIds.indexOf(viewId))
    const rect = target.getBoundingClientRect()
    dropSlotRef.current = home
    dragRef.current = {
      viewId,
      startX: event.clientX,
      startY: event.clientY,
      pointerId: event.pointerId,
      hasMoved: false,
      widthPx: target.offsetWidth,
      grabOffsetX: event.clientX - rect.left,
      floatTop: rect.top,
      homeSlot: home,
      peerStrip: null,
    }
  }

  function onTabPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.hasMoved) return

    const moved = markDragMoved(drag, event.clientX, event.clientY)
    if (!moved) return

    event.preventDefault()
    drag.peerStrip = capturePeerStrip(tabsRef.current, drag.viewId, drag.widthPx)
    setSlideAnimated(false)
    setDragWidthPx(drag.widthPx)
    setGapPx(drag.peerStrip?.gapPx ?? 2)
    setHomeSlot(drag.homeSlot)
    dropSlotRef.current = drag.homeSlot
    setDropSlot(drag.homeSlot)
    setFloat(floatFromPointer(drag, event.clientX))
    setDraggingId(drag.viewId)
    armSlideAnimation()
  }

  function onTabPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    if (!drag.hasMoved) {
      const viewId = drag.viewId
      clearDragSession()
      try {
        event.currentTarget.releasePointerCapture(drag.pointerId)
      } catch (err: unknown) { console.error("[mia]", err) }
      if (isZenViewId(viewId)) activateViewIfNeeded(viewId)
      return
    }
  }

  function onTabPointerCancel(): void {
    if (!dragRef.current) return
    if (dragRef.current.hasMoved) return
    clearDragSession()
  }

  function onTabLostPointerCapture(): void {
    if (!dragRef.current || dragRef.current.hasMoved) return
    clearDragSession()
  }

  return {
    draggingId,
    homeSlot,
    dropSlot,
    dragWidthPx,
    gapPx,
    float,
    slideAnimated,
    pointerSession,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
    onTabPointerCancel,
    onTabLostPointerCapture,
  }
}
