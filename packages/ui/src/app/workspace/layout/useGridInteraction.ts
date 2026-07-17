import { useCallback, useEffect, useRef, useState } from "react"
import {
  colWidth as computeColWidth,
  pixelsToGridRect,
  reclaimSpace,
  rectToPixels,
  resolveDragLayout,
  resolveOverlaps,
  ROW_PX,
  snapDragRect,
  type GridRect,
  type LayoutTile,
} from "../../../lib/grid-math"
import { useLayoutStore } from "../../../state/layout-store"

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"

interface Options {
  viewId: string
  tiles: LayoutTile[]
  containerWidth: number
  maxRows: number
  rowPx?: number
}

interface DragSession {
  tileId: string
  mode: "drag" | "resize"
  edge?: ResizeEdge
  startX: number
  startY: number
  origin: LayoutTile
  originPixels: ReturnType<typeof rectToPixels>
  baseTiles: LayoutTile[]
}

function isInteractiveChrome(target: EventTarget | null): boolean {
  return target instanceof Element
    && !!target.closest(".widget-controls, button, a, input, textarea, select")
}

export function useGridInteraction({
  viewId,
  tiles,
  containerWidth,
  maxRows,
  rowPx = ROW_PX,
}: Options) {
  const updateTileRect = useLayoutStore((s) => s.updateTileRect)
  const updateTiles = useLayoutStore((s) => s.updateTiles)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<GridRect | null>(null)
  const [layoutPreview, setLayoutPreview] = useState<LayoutTile[] | null>(null)
  const sessionRef = useRef<DragSession | null>(null)
  const tilesRef = useRef(tiles)
  tilesRef.current = tiles

  const cw = containerWidth > 0 ? computeColWidth(containerWidth) : 0
  const rows = Math.max(1, maxRows)
  const interactionsLocked = !!soloTileId

  const clearSession = useCallback(() => {
    setDraggingId(null)
    setCandidate(null)
    setLayoutPreview(null)
    sessionRef.current = null
  }, [])

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const session = sessionRef.current
      if (!session || cw <= 0) return

      const deltaX = event.clientX - session.startX
      const deltaY = event.clientY - session.startY

      if (session.mode === "drag") {
        const next = snapDragRect(session.origin, deltaX, deltaY, cw, rows, rowPx)
        const resolved = resolveDragLayout(
          session.baseTiles,
          session.tileId,
          next,
          session.origin,
          rows,
        )
        // No lock — after a slot swap both tiles must be free to reclaim residual gaps.
        setCandidate(next)
        setLayoutPreview(reclaimSpace(resolved, rows))
        return
      }

      const edge = session.edge!
      const base = session.originPixels
      let left = base.left
      let top = base.top
      let width = base.width
      let height = base.height

      if (edge.includes("e")) width = Math.max(base.width + deltaX, cw)
      if (edge.includes("w")) {
        left = base.left + deltaX
        width = base.width - deltaX
      }
      if (edge.includes("s")) height = Math.max(base.height + deltaY, rowPx)
      if (edge.includes("n")) {
        top = base.top + deltaY
        height = base.height - deltaY
      }

      const next = pixelsToGridRect(
        { left, top, width, height },
        cw,
        session.origin.minW,
        session.origin.minH,
        rows,
        rowPx,
      )
      const locked = new Set([session.tileId])
      const resized = session.baseTiles.map((tile) =>
        tile.id === session.tileId ? { ...tile, ...next } : tile,
      )
      const resolved = resolveOverlaps(resized, rows, locked)
      setCandidate(next)
      setLayoutPreview(reclaimSpace(resolved, rows, locked))
    }

    function onUp(event: PointerEvent) {
      const session = sessionRef.current
      if (!session) return
      event.preventDefault()

      const deltaX = event.clientX - session.startX
      const deltaY = event.clientY - session.startY

      if (session.mode === "drag") {
        const next = snapDragRect(session.origin, deltaX, deltaY, cw, rows, rowPx)
        const resolved = resolveDragLayout(
          session.baseTiles,
          session.tileId,
          next,
          session.origin,
          rows,
        )
        // Commit without locking so reclaimSpace can pack the canvas fully.
        updateTiles(viewId, reclaimSpace(resolved, rows))
        clearSession()
        return
      }

      const edge = session.edge!
      const base = session.originPixels
      let left = base.left
      let top = base.top
      let width = base.width
      let height = base.height

      if (edge.includes("e")) width = Math.max(base.width + deltaX, cw)
      if (edge.includes("w")) {
        left = base.left + deltaX
        width = base.width - deltaX
      }
      if (edge.includes("s")) height = Math.max(base.height + deltaY, rowPx)
      if (edge.includes("n")) {
        top = base.top + deltaY
        height = base.height - deltaY
      }

      updateTileRect(
        viewId,
        session.tileId,
        pixelsToGridRect(
          { left, top, width, height },
          cw,
          session.origin.minW,
          session.origin.minH,
          rows,
          rowPx,
        ),
      )
      clearSession()
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [clearSession, cw, rowPx, rows, updateTileRect, updateTiles, viewId])

  const onPointerDownDrag = useCallback((tile: LayoutTile, event: React.PointerEvent) => {
    if (cw <= 0 || tile.pinned || interactionsLocked) return
    if (isInteractiveChrome(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    const baseTiles = tilesRef.current.map((t) => ({ ...t }))
    sessionRef.current = {
      tileId: tile.id,
      mode: "drag",
      startX: event.clientX,
      startY: event.clientY,
      origin: tile,
      originPixels: rectToPixels(tile, cw, rowPx),
      baseTiles,
    }
    setDraggingId(tile.id)
    setCandidate({ x: tile.x, y: tile.y, w: tile.w, h: tile.h })
    setLayoutPreview(baseTiles)
  }, [cw, interactionsLocked, rowPx])

  const onPointerDownResize = useCallback((tile: LayoutTile, edge: ResizeEdge) => {
    return (event: React.PointerEvent) => {
      if (cw <= 0 || tile.pinned || interactionsLocked) return
      event.preventDefault()
      event.stopPropagation()
      const baseTiles = tilesRef.current.map((t) => ({ ...t }))
      sessionRef.current = {
        tileId: tile.id,
        mode: "resize",
        edge,
        startX: event.clientX,
        startY: event.clientY,
        origin: tile,
        originPixels: rectToPixels(tile, cw, rowPx),
        baseTiles,
      }
      setDraggingId(tile.id)
      setCandidate({ x: tile.x, y: tile.y, w: tile.w, h: tile.h })
      setLayoutPreview(baseTiles)
    }
  }, [cw, interactionsLocked, rowPx])

  return {
    draggingId,
    candidate,
    layoutPreview,
    onPointerDownDrag,
    onPointerDownResize,
  }
}
