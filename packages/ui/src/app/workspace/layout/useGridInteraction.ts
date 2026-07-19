import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import {
  COLS,
  GRID_MARGIN,
  colWidth as computeColWidth,
  rectToPixels,
  ROW_PX,
  type LayoutTile,
} from "../../../lib/grid-math"
import {
  dropZoneFromPoint,
  findDividerForLeafEdge,
  getNodeAt,
  projectTiles,
  ratioFromPixelDelta,
  reparentLeaf,
  setSplitRatio,
  splitBoundsAt,
  type DropZone,
  type SplitNode,
  type SplitPath,
} from "../../../lib/split-tree"
import { useLayoutStore } from "../../../state/layout-store"

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"

interface Options {
  viewId: string
  tiles: LayoutTile[]
  split: SplitNode | null
  containerWidth: number
  maxRows: number
  rowPx?: number
  /** Canvas host used for drop hit-testing (grid inner surface). */
  canvasRef: RefObject<HTMLElement | null>
}

interface DragSession {
  tileId: string
  mode: "drag" | "resize"
  edge?: ResizeEdge
  startX: number
  startY: number
  origin: LayoutTile
  originPixels: ReturnType<typeof rectToPixels>
  baseSplit: SplitNode
  /** Resize: which split owns the divider. */
  dividerPath?: SplitPath
  dividerDir?: "h" | "v"
  originRatio?: number
}

export type GridInteractionMode = "drag" | "resize"

export interface DropPreview {
  targetId: string
  zone: DropZone
  rect: { x: number; y: number; w: number; h: number }
}

function isInteractiveChrome(target: EventTarget | null): boolean {
  return target instanceof Element
    && !!target.closest(".widget-controls, button, a, input, textarea, select")
}

function orthoEdges(handle: ResizeEdge): Array<"n" | "s" | "e" | "w"> {
  const edges: Array<"n" | "s" | "e" | "w"> = []
  if (handle.includes("n")) edges.push("n")
  if (handle.includes("s")) edges.push("s")
  if (handle.includes("e")) edges.push("e")
  if (handle.includes("w")) edges.push("w")
  return edges
}

function axisSpanPx(
  bounds: { w: number; h: number },
  dir: "h" | "v",
  cw: number,
  rowPx: number,
): number {
  if (dir === "v") return bounds.w * cw + Math.max(0, bounds.w - 1) * GRID_MARGIN
  return bounds.h * rowPx + Math.max(0, bounds.h - 1) * GRID_MARGIN
}

function resizePreview(
  session: DragSession,
  base: SplitNode,
  clientX: number,
  clientY: number,
  cw: number,
  rowPx: number,
  rows: number,
): SplitNode | null {
  if (!session.dividerPath || !session.dividerDir || session.originRatio == null) return null
  const bounds = splitBoundsAt(base, session.dividerPath, COLS, rows)
  if (!bounds) return null
  const span = axisSpanPx(bounds, session.dividerDir, cw, rowPx)
  // Mouse delta matches growing side `a` (right/down increases ratio) for every
  // divider handle — east of left, west of right, south of top, north of bottom.
  const deltaX = clientX - session.startX
  const deltaY = clientY - session.startY
  const raw = session.dividerDir === "v" ? deltaX : deltaY
  const ratio = ratioFromPixelDelta(session.originRatio, raw, span)
  return setSplitRatio(base, session.dividerPath, ratio)
}

interface DropResolve {
  preview: DropPreview
  /** Tree after reparent — same as commit on pointer-up. */
  split: SplitNode
  /** Projected tiles for that tree (overlay + live reflow). */
  tiles: LayoutTile[]
}

/**
 * Hit-test against the *pre-drag* layout, then resolve the destination rect from
 * the reparented tree so the purple frame matches the post-drop leaf size.
 */
function resolveDrop(
  tiles: readonly LayoutTile[],
  base: SplitNode,
  dragId: string,
  clientX: number,
  clientY: number,
  canvasEl: HTMLElement | null,
  cw: number,
  rowPx: number,
  rows: number,
): DropResolve | null {
  if (!canvasEl || cw <= 0) return null
  const host = (canvasEl.querySelector("[data-workspace-grid]") as HTMLElement | null) ?? canvasEl
  const bounds = host.getBoundingClientRect()
  const localX = clientX - bounds.left
  const localY = clientY - bounds.top

  let hit: LayoutTile | null = null
  for (const tile of tiles) {
    if (tile.id === dragId || tile.pinned) continue
    const px = rectToPixels(tile, cw, rowPx)
    if (
      localX >= px.left
      && localX < px.left + px.width
      && localY >= px.top
      && localY < px.top + px.height
    ) {
      hit = tile
      break
    }
  }
  if (!hit) return null

  const px = rectToPixels(hit, cw, rowPx)
  const zone = dropZoneFromPoint(localX - px.left, localY - px.top, px.width, px.height)
  const next = reparentLeaf(base, dragId, hit.id, zone)
  if (!next) return null
  const projected = projectTiles(next, tiles, COLS, rows)
  const dest = projected.find((tile) => tile.id === dragId)
  if (!dest) return null

  return {
    preview: {
      targetId: hit.id,
      zone,
      rect: { x: dest.x, y: dest.y, w: dest.w, h: dest.h },
    },
    split: next,
    tiles: projected,
  }
}

export function useGridInteraction({
  viewId,
  tiles,
  split,
  containerWidth,
  maxRows,
  rowPx = ROW_PX,
  canvasRef,
}: Options) {
  const commitSplit = useLayoutStore((s) => s.commitSplit)
  const soloTileId = useLayoutStore((s) => s.soloTileId)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [interactionMode, setInteractionMode] = useState<GridInteractionMode | null>(null)
  const [layoutPreview, setLayoutPreview] = useState<LayoutTile[] | null>(null)
  const [dropPreview, setDropPreview] = useState<DropPreview | null>(null)
  const sessionRef = useRef<DragSession | null>(null)
  const splitRef = useRef(split)
  const tilesRef = useRef(tiles)
  splitRef.current = split
  tilesRef.current = tiles

  const cw = containerWidth > 0 ? computeColWidth(containerWidth) : 0
  const rows = Math.max(1, maxRows)
  const interactionsLocked = !!soloTileId

  const clearSession = useCallback(() => {
    setDraggingId(null)
    setInteractionMode(null)
    setLayoutPreview(null)
    setDropPreview(null)
    sessionRef.current = null
  }, [])

  useEffect(() => {
    function onMove(event: PointerEvent) {
      const session = sessionRef.current
      const base = splitRef.current
      if (!session || !base || cw <= 0) return

      if (session.mode === "drag") {
        const drop = resolveDrop(
          tilesRef.current,
          base,
          session.tileId,
          event.clientX,
          event.clientY,
          canvasRef.current,
          cw,
          rowPx,
          rows,
        )
        if (!drop) {
          setDropPreview(null)
          setLayoutPreview(projectTiles(base, tilesRef.current, COLS, rows))
          return
        }
        setDropPreview(drop.preview)
        setLayoutPreview(drop.tiles)
        return
      }

      if (!session.dividerPath || !session.dividerDir || session.originRatio == null) return
      const next = resizePreview(session, base, event.clientX, event.clientY, cw, rowPx, rows)
      if (next) setLayoutPreview(projectTiles(next, tilesRef.current, COLS, rows))
    }

    function onUp(event: PointerEvent) {
      const session = sessionRef.current
      const base = splitRef.current
      if (!session || !base) return
      event.preventDefault()

      if (session.mode === "drag") {
        const drop = resolveDrop(
          tilesRef.current,
          base,
          session.tileId,
          event.clientX,
          event.clientY,
          canvasRef.current,
          cw,
          rowPx,
          rows,
        )
        if (drop) commitSplit(viewId, drop.split)
        clearSession()
        return
      }

      if (!session.dividerPath || session.originRatio == null) {
        clearSession()
        return
      }
      const next = resizePreview(session, base, event.clientX, event.clientY, cw, rowPx, rows)
      if (next) commitSplit(viewId, next)
      clearSession()
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
    }
  }, [clearSession, commitSplit, cw, rowPx, rows, viewId])

  const onPointerDownDrag = useCallback((tile: LayoutTile, event: React.PointerEvent) => {
    if (cw <= 0 || tile.pinned || interactionsLocked || !splitRef.current) return
    if (isInteractiveChrome(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    sessionRef.current = {
      tileId: tile.id,
      mode: "drag",
      startX: event.clientX,
      startY: event.clientY,
      origin: tile,
      originPixels: rectToPixels(tile, cw, rowPx),
      baseSplit: splitRef.current,
    }
    setDraggingId(tile.id)
    setInteractionMode("drag")
    setLayoutPreview(tilesRef.current)
    setDropPreview(null)
  }, [cw, interactionsLocked, rowPx])

  const onPointerDownResize = useCallback((tile: LayoutTile, edge: ResizeEdge) => {
    return (event: React.PointerEvent) => {
      if (cw <= 0 || tile.pinned || interactionsLocked || !splitRef.current) return
      event.preventDefault()
      event.stopPropagation()

      const edges = orthoEdges(edge)
      let hit = null as ReturnType<typeof findDividerForLeafEdge>
      for (const ortho of edges) {
        hit = findDividerForLeafEdge(splitRef.current, tile.id, ortho, COLS, rows)
        if (hit) break
      }
      // Corner / outer canvas edge with no split divider — ignore (tree always fills).
      if (!hit) return
      const splitNode = getNodeAt(splitRef.current, hit.path)
      const originRatio = splitNode?.kind === "split" ? splitNode.ratio : 0.5

      sessionRef.current = {
        tileId: tile.id,
        mode: "resize",
        edge,
        startX: event.clientX,
        startY: event.clientY,
        origin: tile,
        originPixels: rectToPixels(tile, cw, rowPx),
        baseSplit: splitRef.current,
        dividerPath: hit.path,
        dividerDir: hit.dir,
        originRatio,
      }
      setDraggingId(tile.id)
      setInteractionMode("resize")
      setLayoutPreview(tilesRef.current)
      setDropPreview(null)
    }
  }, [cw, interactionsLocked, rowPx, rows])

  return {
    draggingId,
    interactionMode,
    layoutPreview,
    dropPreview,
    onPointerDownDrag,
    onPointerDownResize,
  }
}
