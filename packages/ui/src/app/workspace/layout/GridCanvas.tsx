import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import {
  COLS,
  viewportGridMetrics,
  rectToPixels,
  type LayoutTile,
} from "../../../lib/grid-math"
import {
  reparentLeaf,
  type DropZone,
  type SplitNode,
} from "../../../lib/split-tree"
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
  split: SplitNode | null
  onOpenCatalog?: () => void
}

interface GridTilePaneProps {
  viewId: string
  tile: LayoutTile
  display: LayoutTile
  cw: number
  rowPx: number
  isDragging: boolean
  isResizing: boolean
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
  isResizing,
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
      className={`workspace-tile ${isDragging ? "workspace-tile-dragging" : ""} ${
        isResizing ? "workspace-tile-resizing" : ""
      } ${entranceClassName(isEntering)} ${
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

function neighborInDirection(
  tiles: readonly LayoutTile[],
  focused: LayoutTile,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): { neighbor: LayoutTile; zone: DropZone } | null {
  const candidates = tiles.filter((tile) => tile.id !== focused.id && !tile.pinned)
  if (candidates.length === 0) return null

  if (key === "ArrowLeft") {
    const hit = candidates
      .filter((tile) => tile.x + tile.w <= focused.x
        && Math.min(focused.y + focused.h, tile.y + tile.h) - Math.max(focused.y, tile.y) > 0)
      .sort((a, b) => (b.x + b.w) - (a.x + a.w))[0]
    return hit ? { neighbor: hit, zone: "e" } : null
  }
  if (key === "ArrowRight") {
    const hit = candidates
      .filter((tile) => tile.x >= focused.x + focused.w
        && Math.min(focused.y + focused.h, tile.y + tile.h) - Math.max(focused.y, tile.y) > 0)
      .sort((a, b) => a.x - b.x)[0]
    return hit ? { neighbor: hit, zone: "w" } : null
  }
  if (key === "ArrowUp") {
    const hit = candidates
      .filter((tile) => tile.y + tile.h <= focused.y
        && Math.min(focused.x + focused.w, tile.x + tile.w) - Math.max(focused.x, tile.x) > 0)
      .sort((a, b) => (b.y + b.h) - (a.y + a.h))[0]
    return hit ? { neighbor: hit, zone: "s" } : null
  }
  const hit = candidates
    .filter((tile) => tile.y >= focused.y + focused.h
      && Math.min(focused.x + focused.w, tile.x + tile.w) - Math.max(focused.x, tile.x) > 0)
    .sort((a, b) => a.y - b.y)[0]
  return hit ? { neighbor: hit, zone: "n" } : null
}

export function GridCanvas({ viewId, tiles, split }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const enteringTileIds = useLayoutStore((s) => s.enteringTileIds)
  const clearEntering = useLayoutStore((s) => s.clearEntering)
  const setFocusedTile = useLayoutStore((s) => s.setFocusedTile)
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const commitSplit = useLayoutStore((s) => s.commitSplit)
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
    interactionMode,
    layoutPreview,
    dropPreview,
    onPointerDownDrag,
    onPointerDownResize,
  } = useGridInteraction({
    viewId,
    tiles,
    split,
    containerWidth: Math.max(0, containerWidth - CANVAS_PAD_PX * 2),
    maxRows,
    rowPx,
    canvasRef: containerRef,
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
    function onKeyDown(event: KeyboardEvent) {
      if (!focusedTileId || soloTileId || !split) return
      if (!(event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowUp" || event.key === "ArrowDown")) {
        return
      }
      const target = event.target as HTMLElement | null
      if (target?.closest(".widget-content, input, textarea, [contenteditable='true']")) return

      const tile = tiles.find((t) => t.id === focusedTileId)
      if (!tile || tile.pinned) return

      const hit = neighborInDirection(tiles, tile, event.key)
      if (!hit) return
      event.preventDefault()
      const next = reparentLeaf(split, tile.id, hit.neighbor.id, hit.zone)
      commitSplit(viewId, next)
    }

    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [focusedTileId, tiles, commitSplit, viewId, maxRows, soloTileId, split])

  const soloTile = soloTileId ? tiles.find((tile) => tile.id === soloTileId) : null
  // Drag keeps committed geometry (static). Resize still uses live layoutPreview.
  const visibleTiles = soloTile
    ? [{ ...soloTile, x: 0, y: 0, w: COLS, h: maxRows }]
    : (interactionMode === "resize" ? (layoutPreview ?? tiles) : tiles)

  const interacting = !soloTileId && !!draggingId
  const dragSource = draggingId ? tiles.find((tile) => tile.id === draggingId) : null

  return (
    <div
      ref={containerRef}
      className={[
        "relative h-full w-full overflow-hidden p-1",
        interacting ? "workspace-canvas-interacting" : "",
        interacting && interactionMode === "resize" ? "workspace-canvas-resizing" : "",
        interacting && interactionMode === "drag" ? "workspace-canvas-dragging" : "",
      ].join(" ")}
    >
      {cw > 0 && (
        <div data-workspace-grid className="relative h-full w-full">
          {visibleTiles.map((tile) => {
            const source = tiles.find((t) => t.id === tile.id) ?? tile
            const isActive = !soloTileId && draggingId === tile.id
            const isDragging = isActive && interactionMode === "drag"
            const isResizing = isActive && interactionMode === "resize"
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
                isResizing={isResizing}
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

          {!soloTileId && interactionMode === "drag" && (
            <DropZoneOverlay
              preview={dropPreview}
              widgetType={dragSource?.type ?? null}
              colWidth={cw}
              rowPx={rowPx}
            />
          )}
        </div>
      )}
    </div>
  )
}
