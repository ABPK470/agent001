import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import {
  COLS,
  clampRectToGrid,
  resolveDragLayout,
  viewportGridMetrics,
  rectToPixels,
  type GridRect,
  type LayoutTile,
} from "../../../lib/grid-math"
import { useLayoutStore } from "../../../state/layout-store"
import { WidgetShell } from "../WidgetShell"
import { widgetComponent } from "../widget-definitions"
import { DropZoneOverlay } from "./DropZoneOverlay"
import { entranceClassName } from "./motion"
import { useGridInteraction, type ResizeEdge } from "./useGridInteraction"

const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"]
const CANVAS_PAD_PX = 4

interface Props {
  viewId: string
  tiles: LayoutTile[]
  onOpenCatalog?: () => void
}

interface GridTilePaneProps {
  viewId: string
  tile: LayoutTile
  display: LayoutTile
  cw: number
  rowPx: number
  isDragging: boolean
  isEntering: boolean
  isFocused: boolean
  maximized: boolean
  onFocus: () => void
  onBlur: () => void
  onTransitionEnd: () => void
  onDragPointerDown: (event: ReactPointerEvent) => void
  onResizePointerDown: (edge: ResizeEdge) => (event: ReactPointerEvent) => void
}

const GridTilePane = memo(function GridTilePane({
  viewId,
  tile,
  display,
  cw,
  rowPx,
  isDragging,
  isEntering,
  isFocused,
  maximized,
  onFocus,
  onBlur,
  onTransitionEnd,
  onDragPointerDown,
  onResizePointerDown,
}: GridTilePaneProps) {
  const pixels = rectToPixels(display, cw, rowPx)
  const Widget = widgetComponent(tile.type)
  const locked = !!(tile.pinned || maximized)

  return (
    <div
      data-tile-id={tile.id}
      tabIndex={0}
      className={`workspace-tile ${isDragging ? "workspace-tile-dragging" : ""} ${entranceClassName(isEntering)} ${
        isFocused ? "workspace-tile-focused" : ""
      } ${locked ? "workspace-tile-locked" : ""}`}
      style={{
        left: pixels.left,
        top: pixels.top,
        width: pixels.width,
        height: pixels.height,
      }}
      onFocus={onFocus}
      onBlur={onBlur}
      onTransitionEnd={onTransitionEnd}
    >
      <WidgetShell
        widgetId={tile.id}
        viewId={viewId}
        type={tile.type}
        pinned={!!tile.pinned}
        edgePin={tile.edgePin}
        maximized={maximized}
        onDragPointerDown={onDragPointerDown}
      >
        <Widget />
      </WidgetShell>

      {!locked && RESIZE_EDGES.map((edge) => (
        <button
          key={edge}
          type="button"
          aria-label={`Resize ${edge}`}
          className={`workspace-resize-handle workspace-resize-handle-${edge}`}
          onPointerDown={onResizePointerDown(edge)}
        />
      ))}
    </div>
  )
})

export function GridCanvas({ viewId, tiles }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const enteringTileIds = useLayoutStore((s) => s.enteringTileIds)
  const clearEntering = useLayoutStore((s) => s.clearEntering)
  const setFocusedTile = useLayoutStore((s) => s.setFocusedTile)
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const updateTiles = useLayoutStore((s) => s.updateTiles)
  const setViewportRows = useLayoutStore((s) => s.setViewportRows)
  const viewportRows = useLayoutStore((s) => s.viewportRows)

  const metrics = useMemo(() => {
    const innerW = Math.max(0, containerWidth - CANVAS_PAD_PX * 2)
    const innerH = Math.max(0, containerHeight - CANVAS_PAD_PX * 2)
    if (innerW <= 0 || innerH <= 0) {
      return { rows: viewportRows, colW: 0, rowPx: 32 }
    }
    return viewportGridMetrics(innerW, innerH)
  }, [containerWidth, containerHeight, viewportRows])

  const maxRows = metrics.rows
  const cw = metrics.colW
  const rowPx = metrics.rowPx

  const {
    draggingId,
    candidate,
    layoutPreview,
    onPointerDownDrag,
    onPointerDownResize,
  } = useGridInteraction({
    viewId,
    tiles,
    containerWidth: Math.max(0, containerWidth - CANVAS_PAD_PX * 2),
    maxRows,
    rowPx,
  })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
        setContainerHeight(entry.contentRect.height)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (maxRows > 0) setViewportRows(maxRows)
  }, [maxRows, setViewportRows])

  useEffect(() => {
    for (const tileId of enteringTileIds) {
      requestAnimationFrame(() => {
        const el = containerRef.current?.querySelector(`[data-tile-id="${tileId}"]`)
        el?.classList.remove("workspace-tile-entering")
        el?.classList.add("workspace-tile-entered")
      })
    }
  }, [enteringTileIds])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!focusedTileId || soloTileId) return
      if (!(event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown")) {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest(".widget-content, input, textarea, [contenteditable='true']")) return

      const tile = tiles.find((t) => t.id === focusedTileId)
      if (!tile || tile.pinned) return

      event.preventDefault()
      const step = event.shiftKey ? 2 : 1
      const next: GridRect = {
        x: tile.x,
        y: tile.y,
        w: tile.w,
        h: tile.h,
      }
      if (event.key === "ArrowLeft") next.x = tile.x - step
      if (event.key === "ArrowRight") next.x = tile.x + step
      if (event.key === "ArrowUp") next.y = tile.y - step
      if (event.key === "ArrowDown") next.y = tile.y + step
      const preview = resolveDragLayout(
        tiles,
        tile.id,
        clampRectToGrid(next, maxRows, tile.minW, tile.minH),
        tile,
        maxRows,
      )
      updateTiles(viewId, preview)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [focusedTileId, tiles, updateTiles, viewId, maxRows, soloTileId])

  const soloTile = soloTileId ? tiles.find((tile) => tile.id === soloTileId) : null
  const visibleTiles = soloTile
    ? [{ ...soloTile, x: 0, y: 0, w: COLS, h: maxRows }]
    : (layoutPreview ?? tiles)

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden p-1"
    >
      {cw > 0 && (
        <div className="relative h-full w-full">
          {visibleTiles.map((tile) => {
            const source = tiles.find((t) => t.id === tile.id) ?? tile
            const isDragging = !soloTileId && draggingId === tile.id
            const isEntering = enteringTileIds.includes(tile.id)
            const maximized = soloTileId === tile.id

            return (
              <GridTilePane
                key={tile.id}
                viewId={viewId}
                tile={source}
                display={tile}
                cw={cw}
                rowPx={rowPx}
                isDragging={isDragging}
                isEntering={isEntering}
                isFocused={focusedTileId === tile.id}
                maximized={maximized}
                onFocus={() => setFocusedTile(tile.id)}
                onBlur={() => setFocusedTile(null)}
                onTransitionEnd={() => {
                  if (isEntering) clearEntering(tile.id)
                }}
                onDragPointerDown={(event) => onPointerDownDrag(source, event)}
                onResizePointerDown={(edge) => onPointerDownResize(source, edge)}
              />
            )
          })}

          {!soloTileId && <DropZoneOverlay candidate={candidate} colWidth={cw} rowPx={rowPx} />}
        </div>
      )}
    </div>
  )
}
