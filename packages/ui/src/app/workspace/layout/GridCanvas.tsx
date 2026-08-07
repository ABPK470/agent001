/**
 * GridCanvas — absolute tiles on the stage.
 *
 * Stage pad is applied in JS (not CSS padding) so solo maximize can fill the
 * stage edge-to-edge — container size stays fixed, no ResizeObserver mid-morph,
 * no negative-bleed clipping. Solo toggle snaps W/H once, then FLIP-animates
 * via transform so expanded Trace/Chat are not reflowed for 260ms.
 */

import {
    memo,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type PointerEvent as ReactPointerEvent,
} from "react"
import {
    COLS,
    rectToPixels,
    viewportGridMetrics,
    type LayoutTile,
} from "../../../lib/grid-math"
import {
    projectTiles,
    reparentLeaf,
    type DropZone,
    type SplitNode,
} from "../../../lib/split-tree"
import { useLayoutStore } from "../../../state/layout-store"
import { WidgetShell } from "../WidgetShell"
import { TilePaintProvider } from "../tile-paint"
import { widgetComponent } from "../widget-definitions"
import { DropZoneOverlay } from "./DropZoneOverlay"
import { entranceClassName } from "./motion"
import { paintTilesForCanvas } from "./paint-tiles"
import {
    readTileRectInCanvas,
    SOLO_FLIP_MS,
    soloFlipInvertTransform,
    takeSoloFlipFrom,
} from "./solo-flip"
import { useGridInteraction, type ResizeEdge } from "./useGridInteraction"

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

type SoloFlipPlay = {
  tile: HTMLElement
  canvas: HTMLElement
  cleaned: boolean
  playRaf: number
  safetyTimer: number
  onTransitionEnd: (event: TransitionEvent) => void
}

function clearSoloFlipStyles(tile: HTMLElement, canvas: HTMLElement) {
  tile.style.transform = ""
  tile.style.transformOrigin = ""
  tile.classList.remove("workspace-tile-solo-flipping", "is-solo-flip-arming")
  canvas.classList.remove("workspace-canvas-geometry-snap")
}

function finishSoloFlip(play: SoloFlipPlay) {
  if (play.cleaned) return
  play.cleaned = true
  cancelAnimationFrame(play.playRaf)
  window.clearTimeout(play.safetyTimer)
  play.tile.removeEventListener("transitionend", play.onTransitionEnd)
  clearSoloFlipStyles(play.tile, play.canvas)
}

function onSoloFlipTransitionEnd(play: SoloFlipPlay, event: TransitionEvent) {
  if (event.target !== play.tile) return
  if (event.propertyName !== "transform") return
  finishSoloFlip(play)
}

function beginSoloFlipEase(play: SoloFlipPlay) {
  // Drop arming — CSS `.workspace-tile-solo-flipping` owns the 260ms ease.
  play.tile.classList.remove("is-solo-flip-arming")
  // Force style flush so the next transform change actually transitions.
  void play.tile.offsetWidth
  play.tile.style.transform = "translate(0px, 0px) scale(1)"
  play.tile.addEventListener("transitionend", play.onTransitionEnd)
  play.safetyTimer = window.setTimeout(() => finishSoloFlip(play), SOLO_FLIP_MS + 120)
}

function playSoloFlip(canvas: HTMLElement, tile: HTMLElement, from: {
  left: number
  top: number
  width: number
  height: number
}): () => void {
  /*
   * Snap geometry BEFORE measuring `to`. On restore the tile loses
   * `.workspace-tile-solo` (transition: none) in the same commit as the
   * small rect — so width/height 260ms transitions arm and
   * getBoundingClientRect still reads the full solo size. Invert looks
   * like a no-op and restore snaps. Maximize is fine because solo keeps
   * transition: none through the commit.
   */
  canvas.classList.add("workspace-canvas-geometry-snap")
  void tile.offsetWidth
  const to = readTileRectInCanvas(tile, canvas)
  const invert = soloFlipInvertTransform(from, to)
  if (!invert || prefersReducedMotion()) {
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        canvas.classList.remove("workspace-canvas-geometry-snap")
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      canvas.classList.remove("workspace-canvas-geometry-snap")
    }
  }

  const play: SoloFlipPlay = {
    tile,
    canvas,
    cleaned: false,
    playRaf: 0,
    safetyTimer: 0,
    onTransitionEnd: (event) => onSoloFlipTransitionEnd(play, event),
  }

  tile.style.transformOrigin = "0 0"
  tile.classList.add("workspace-tile-solo-flipping", "is-solo-flip-arming")
  tile.style.transform =
    `translate(${invert.dx}px, ${invert.dy}px) scale(${invert.sx}, ${invert.sy})`

  play.playRaf = requestAnimationFrame(() => {
    play.playRaf = requestAnimationFrame(() => beginSoloFlipEase(play))
  })

  return () => finishSoloFlip(play)
}
const RESIZE_EDGES: ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"]

/** Match `.workspace-chrome { --stage-pad: 0.625rem }`. */
function readStagePadPx(from: HTMLElement): number {
  const host = from.closest(".workspace-chrome") ?? from
  const probe = document.createElement("div")
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;padding:var(--stage-pad)"
  host.appendChild(probe)
  const px = Number.parseFloat(getComputedStyle(probe).paddingLeft)
  probe.remove()
  return Number.isFinite(px) ? px : 10
}

interface Props {
  viewId: string
  tiles: LayoutTile[]
  split: SplitNode | null
}

interface GridTilePaneProps {
  viewId: string
  tile: LayoutTile
  display: LayoutTile
  cw: number
  rowPx: number
  stagePadPx: number
  canvasWidth: number
  canvasHeight: number
  isDragging: boolean
  isResizing: boolean
  isEntering: boolean
  isFocused: boolean
  maximized: boolean
  zen: boolean
  soloHidden: boolean
  onFocus: () => void
  /** Pointer down anywhere on the tile — sticky selection (not cleared on blur). */
  onSelect: () => void
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
  stagePadPx,
  canvasWidth,
  canvasHeight,
  isDragging,
  isResizing,
  isEntering,
  isFocused,
  maximized,
  zen,
  soloHidden,
  onFocus,
  onSelect,
  onTransitionEnd,
  onDragPointerDown,
  onResizePointerDown,
}: GridTilePaneProps) {
  const pixels = rectToPixels(display, cw, rowPx)
  const Widget = widgetComponent(tile.type)
  const locked = !!(tile.pinned || maximized)

  const style = maximized
    ? { left: 0, top: 0, width: canvasWidth, height: canvasHeight }
    : {
        left: stagePadPx + pixels.left,
        top: stagePadPx + pixels.top,
        width: pixels.width,
        height: pixels.height,
      }

  return (
    <div
      data-tile-id={tile.id}
      tabIndex={soloHidden ? -1 : 0}
      aria-hidden={soloHidden || undefined}
      ref={(el) => {
        if (!el) return
        if (soloHidden) el.setAttribute("inert", "")
        else el.removeAttribute("inert")
      }}
      className={`workspace-tile ${isDragging ? "workspace-tile-dragging" : ""} ${
        isResizing ? "workspace-tile-resizing" : ""
      } ${entranceClassName(isEntering)} ${
        isFocused && !soloHidden ? "workspace-tile-focused" : ""
      } ${locked ? "workspace-tile-locked" : ""} ${
        maximized ? "workspace-tile-solo" : ""
      } ${zen ? "workspace-tile-zen" : ""} ${
        soloHidden ? "workspace-tile-solo-hidden" : ""
      }`}
      style={style}
      onFocus={onFocus}
      onPointerDownCapture={onSelect}
      onTransitionEnd={onTransitionEnd}
    >
      <WidgetShell
        widgetId={tile.id}
        viewId={viewId}
        type={tile.type}
        pinned={!!tile.pinned}
        maximized={maximized}
        zen={zen}
        onDragPointerDown={onDragPointerDown}
      >
        <TilePaintProvider soloHidden={soloHidden}>
          <Widget />
        </TilePaintProvider>
      </WidgetShell>

      {!locked && !soloHidden && RESIZE_EDGES.map((edge) => (
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
  const [stagePadPx, setStagePadPx] = useState(10)
  const enteringTileIds = useLayoutStore((s) => s.enteringTileIds)
  const clearEntering = useLayoutStore((s) => s.clearEntering)
  const setFocusedTile = useLayoutStore((s) => s.setFocusedTile)
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const zenTileId = useLayoutStore((s) => s.zenTileId)
  const commitSplit = useLayoutStore((s) => s.commitSplit)
  const setViewportRows = useLayoutStore((s) => s.setViewportRows)
  const viewportRows = useLayoutStore((s) => s.viewportRows)

  const layoutWidth = Math.max(0, containerWidth - stagePadPx * 2)
  const layoutHeight = Math.max(0, containerHeight - stagePadPx * 2)

  const metrics = useMemo(() => {
    if (layoutWidth <= 0 || layoutHeight <= 0) {
      return { rows: viewportRows, colW: 0, rowPx: 32 }
    }
    return viewportGridMetrics(layoutWidth, layoutHeight)
  }, [layoutWidth, layoutHeight, viewportRows])

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
    containerWidth: layoutWidth,
    maxRows,
    rowPx,
    canvasRef: containerRef,
    stagePadPx,
  })

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    setStagePadPx(readStagePadPx(el))
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

  /**
   * Maximize/restore: snap W/H (no layout thrash), FLIP via transform for the
   * mature ease. From-rect captured on click before this commit.
   */
  const soloFlipBootRef = useRef(true)
  useLayoutEffect(() => {
    if (soloFlipBootRef.current) {
      soloFlipBootRef.current = false
      return
    }
    const canvas = containerRef.current
    if (!canvas) return
    const from = takeSoloFlipFrom()
    if (!from) {
      canvas.classList.add("workspace-canvas-geometry-snap")
      let innerRaf = 0
      const outerRaf = requestAnimationFrame(() => {
        innerRaf = requestAnimationFrame(() => {
          canvas.classList.remove("workspace-canvas-geometry-snap")
        })
      })
      return () => {
        cancelAnimationFrame(outerRaf)
        cancelAnimationFrame(innerRaf)
        canvas.classList.remove("workspace-canvas-geometry-snap")
      }
    }
    const tile = canvas.querySelector(
      `[data-tile-id="${CSS.escape(from.tileId)}"]`,
    )
    if (!(tile instanceof HTMLElement)) return
    return playSoloFlip(canvas, tile, from)
  }, [soloTileId])

  useEffect(() => {
    for (const tileId of enteringTileIds) {
      requestAnimationFrame(() => {
        const el = containerRef.current?.querySelector(`[data-tile-id="${tileId}"]`)
        el?.classList.remove("workspace-tile-entering")
        el?.classList.add("workspace-tile-entered")
      })
    }
  }, [enteringTileIds])

  // Always have a selected tile in a Space — never “nothing focused”.
  useEffect(() => {
    if (focusedTileId) {
      if (tiles.some((tile) => tile.id === focusedTileId)) return
    }
    const first = tiles[0]
    if (!first) return
    setFocusedTile(first.id)
  }, [focusedTileId, tiles, setFocusedTile])

  // Sticky tile selection: store focus survives clicks into widget content.
  // Sync DOM focus when selection changes from the keyboard (⌘⇧+arrows / Call Space).
  useEffect(() => {
    if (!focusedTileId) return
    const el = containerRef.current?.querySelector(
      `[data-tile-id="${CSS.escape(focusedTileId)}"]`,
    )
    if (!(el instanceof HTMLElement)) return
    if (el === document.activeElement || el.contains(document.activeElement)) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest(".ops-sheet, [role='dialog']")) {
      return
    }
    el.focus({ preventScroll: true })
  }, [focusedTileId])

  // Layout reparent is Shift+Arrow only — bare arrows belong to widget/pane nav;
  // ⌘⇧+arrows moves tile focus (shell operator keyboard).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!focusedTileId || soloTileId || !split) return
      if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
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

  const projectedTiles = useMemo(
    () => projectTiles(split, tiles, COLS, maxRows),
    [split, tiles, maxRows],
  )
  const baseTiles =
    !soloTileId && interactionMode === "resize"
      ? (layoutPreview ?? projectedTiles)
      : projectedTiles
  const paintedTiles = useMemo(
    () => paintTilesForCanvas(baseTiles, soloTileId, maxRows),
    [baseTiles, soloTileId, maxRows],
  )

  const interacting = !soloTileId && !!draggingId
  const dragSource = draggingId ? tiles.find((tile) => tile.id === draggingId) : null

  return (
    <div
      ref={containerRef}
      className={[
        "workspace-canvas-pad relative h-full w-full overflow-hidden",
        interacting ? "workspace-canvas-interacting" : "",
        interacting && interactionMode === "resize" ? "workspace-canvas-resizing" : "",
        interacting && interactionMode === "drag" ? "workspace-canvas-dragging" : "",
      ].join(" ")}
    >
      {cw > 0 && (
        <div data-workspace-grid className="relative h-full w-full">
          {paintedTiles.map(({ tile: painted, display, solo, soloHidden }) => {
            const source = tiles.find((t) => t.id === painted.id) ?? painted
            const isActive = !soloTileId && draggingId === painted.id
            const isDragging = isActive && interactionMode === "drag"
            const isResizing = isActive && interactionMode === "resize"
            const isEntering = enteringTileIds.includes(painted.id)

            return (
              <GridTilePane
                key={painted.id}
                viewId={viewId}
                tile={source}
                display={display}
                cw={cw}
                rowPx={rowPx}
                stagePadPx={stagePadPx}
                canvasWidth={containerWidth}
                canvasHeight={containerHeight}
                isDragging={isDragging}
                isResizing={isResizing}
                isEntering={isEntering}
                isFocused={focusedTileId === painted.id}
                maximized={solo}
                zen={zenTileId === painted.id}
                soloHidden={soloHidden}
                onFocus={() => setFocusedTile(painted.id)}
                onSelect={() => setFocusedTile(painted.id)}
                onTransitionEnd={() => {
                  if (isEntering) clearEntering(painted.id)
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
              stagePadPx={stagePadPx}
            />
          )}
        </div>
      )}
    </div>
  )
}
