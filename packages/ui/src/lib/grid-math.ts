import type { WidgetType } from "../types"
import type { WidgetSizeDefaults } from "./widget-layout-defaults"

export const COLS = 12
export const ROW_PX = 32
export const GRID_MARGIN = 8

export interface GridRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PixelRect {
  left: number
  top: number
  width: number
  height: number
}

export interface LayoutTile extends GridRect {
  id: string
  type: WidgetType
  minW: number
  minH: number
  pinned?: boolean
  /** Geometry to restore after un-maximizing. */
  restore?: GridRect
}

export interface ViewportGridMetrics {
  rows: number
  colW: number
  rowPx: number
}

/** Column width for a 12-column grid with fixed inter-column margin. */
export function colWidth(containerWidth: number): number {
  return (containerWidth - GRID_MARGIN * (COLS - 1)) / COLS
}

/** How many row units fit in a pixel height (nominal ROW_PX). */
export function rowsForHeight(heightPx: number): number {
  if (heightPx <= 0) return 1
  return Math.max(1, Math.floor((heightPx + GRID_MARGIN) / (ROW_PX + GRID_MARGIN)))
}

/**
 * Row count + stretched row height so the grid fills the viewport exactly
 * (no leftover strip at the bottom).
 */
export function viewportGridMetrics(widthPx: number, heightPx: number): ViewportGridMetrics {
  const rows = rowsForHeight(heightPx)
  const rowPx = rows <= 1
    ? Math.max(ROW_PX, heightPx)
    : Math.max(ROW_PX * 0.75, (heightPx - GRID_MARGIN * (rows - 1)) / rows)
  return {
    rows,
    colW: colWidth(Math.max(0, widthPx)),
    rowPx,
  }
}

export function rectToPixels(tile: GridRect, cw: number, rowPx = ROW_PX): PixelRect {
  const unitX = cw + GRID_MARGIN
  const unitY = rowPx + GRID_MARGIN
  return {
    left: tile.x * unitX,
    top: tile.y * unitY,
    width: tile.w * cw + (tile.w - 1) * GRID_MARGIN,
    height: tile.h * rowPx + (tile.h - 1) * GRID_MARGIN,
  }
}

export function contentHeight(tiles: GridRect[], rowPx = ROW_PX): number {
  if (tiles.length === 0) return rowPx
  const maxRow = Math.max(...tiles.map((tile) => tile.y + tile.h))
  return maxRow * rowPx + (maxRow - 1) * GRID_MARGIN
}

export function rectsOverlap(a: GridRect, b: GridRect): boolean {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y
}

export function overlapArea(a: GridRect, b: GridRect): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return w * h
}

/** Clamp a rect so it stays fully inside the COLS × maxRows canvas. */
export function clampRectToGrid(
  rect: GridRect,
  maxRows: number,
  minW = 1,
  minH = 1,
): GridRect {
  const rows = Math.max(1, maxRows)
  const w = Math.min(Math.max(minW, rect.w), COLS)
  const h = Math.min(Math.max(minH, rect.h), rows)
  const x = Math.min(Math.max(0, rect.x), COLS - w)
  const y = Math.min(Math.max(0, rect.y), rows - h)
  return { x, y, w, h }
}

export function clampTile<T extends LayoutTile>(
  tile: T,
  defaults: WidgetSizeDefaults,
  maxRows?: number,
): T {
  const minW = Math.max(defaults.minW, tile.minW)
  const minH = Math.max(defaults.minH, tile.minH)
  if (maxRows && maxRows > 0) {
    const clamped = clampRectToGrid(tile, maxRows, minW, minH)
    return { ...tile, ...clamped, minW: defaults.minW, minH: defaults.minH }
  }
  const w = Math.min(Math.max(tile.w, minW), COLS)
  const h = Math.max(tile.h, minH)
  const x = Math.min(Math.max(0, tile.x), COLS - w)
  const y = Math.max(0, tile.y)
  return { ...tile, x, y, w, h, minW: defaults.minW, minH: defaults.minH }
}

/** Simple top-to-bottom compaction — moves tiles up when space allows. */
export function compactDown(tiles: LayoutTile[]): LayoutTile[] {
  const sorted = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x)
  const placed: LayoutTile[] = []
  for (const tile of sorted) {
    if (tile.pinned || tile.restore) {
      placed.push(tile)
      continue
    }
    let next = { ...tile }
    while (next.y > 0) {
      const candidate = { ...next, y: next.y - 1 }
      const blocked = placed.some((other) => rectsOverlap(candidate, other))
      if (blocked) break
      next = candidate
    }
    placed.push(next)
  }
  return placed
}

/**
 * Ensure no two visible tiles occupy the same cells. Later tiles in
 * reading order are nudged into the nearest free slot; if the canvas is
 * packed, the largest overlapping neighbor is split to make room.
 */
export function resolveOverlaps(tiles: LayoutTile[], maxRows: number): LayoutTile[] {
  const rows = Math.max(1, maxRows)
  const sorted = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id))
  let placed: LayoutTile[] = []

  for (const tile of sorted) {
    if (!placed.some((other) => rectsOverlap(tile, other))) {
      placed.push(tile)
      continue
    }

    const slot = findOpenSlot(tile, placed, rows)
    const candidate = { ...tile, ...slot }
    if (!placed.some((other) => rectsOverlap(candidate, other))) {
      placed.push(candidate)
      continue
    }

    const target = [...placed].sort((a, b) => (b.w * b.h) - (a.w * a.h))[0]
    if (!target) {
      placed.push(candidate)
      continue
    }

    const canSplitHorizontal = target.w >= tile.minW + target.minW && target.w >= 4
    if (canSplitHorizontal) {
      const leftW = Math.max(target.minW, Math.floor(target.w / 2))
      const rightW = target.w - leftW
      placed = placed.map((item) =>
        item.id === target.id ? { ...item, w: leftW } : item,
      )
      placed.push(clampTileLike(tile, {
        x: target.x + leftW,
        y: target.y,
        w: Math.max(tile.minW, rightW),
        h: Math.min(tile.h, target.h),
      }, rows))
      continue
    }

    const topH = Math.max(target.minH, Math.floor(target.h / 2))
    const bottomH = target.h - topH
    placed = placed.map((item) =>
      item.id === target.id ? { ...item, h: topH } : item,
    )
    placed.push(clampTileLike(tile, {
      x: target.x,
      y: target.y + topH,
      w: Math.min(tile.w, target.w),
      h: Math.max(tile.minH, bottomH),
    }, rows))
  }

  const byId = new Map(placed.map((tile) => [tile.id, tile]))
  return tiles.map((tile) => byId.get(tile.id) ?? tile)
}

function clampTileLike(tile: LayoutTile, rect: GridRect, maxRows: number): LayoutTile {
  return {
    ...tile,
    ...clampRectToGrid(rect, maxRows, tile.minW, tile.minH),
  }
}

/** Drop legacy maximize geometry onto the tile and clear `restore`. */
export function clearLegacyMaximize(tile: LayoutTile): LayoutTile {
  if (!tile.restore) return tile
  const { restore, ...rest } = tile
  return { ...rest, ...restore }
}

export function normalizeTiles(
  tiles: LayoutTile[],
  defaultsByType: Record<WidgetType, WidgetSizeDefaults>,
  maxRows?: number,
): LayoutTile[] {
  const clamped = tiles.map((tile) => {
    const cleared = clearLegacyMaximize(tile)
    const defaults = defaultsByType[cleared.type]
    if (!defaults) return cleared
    return clampTile(cleared, defaults, maxRows)
  })
  if (!maxRows || maxRows <= 0) return clamped
  return resolveOverlaps(clamped, maxRows)
}

/** Find a free slot for `tile` that does not overlap `blockers`. */
export function findOpenSlot(
  tile: LayoutTile,
  blockers: LayoutTile[],
  maxRows: number,
): GridRect {
  const rows = Math.max(1, maxRows)
  const tryPlace = (w: number, h: number): GridRect | null => {
    for (let y = 0; y <= rows - h; y++) {
      for (let x = 0; x <= COLS - w; x++) {
        const candidate = { x, y, w, h }
        if (!blockers.some((b) => rectsOverlap(candidate, b))) return candidate
      }
    }
    return null
  }

  const exact = tryPlace(tile.w, tile.h)
  if (exact) return exact

  for (let h = tile.h; h >= tile.minH; h--) {
    for (let w = tile.w; w >= tile.minW; w--) {
      const fit = tryPlace(w, h)
      if (fit) return fit
    }
  }

  return clampRectToGrid({ x: 0, y: 0, w: tile.w, h: tile.h }, rows, tile.minW, tile.minH)
}

/**
 * Live drag resolution: place the dragged tile at `nextRect`, swap with the
 * strongest overlap target (into the drag origin slot), and push any other
 * collisions into the nearest free slot. Always resolves from the pre-drag
 * `tiles` snapshot so neighbors animate fluidly without accumulating drift.
 */
export function resolveDragLayout(
  tiles: LayoutTile[],
  dragId: string,
  nextRect: GridRect,
  origin: GridRect,
  maxRows: number,
): LayoutTile[] {
  const moving = tiles.find((tile) => tile.id === dragId)
  if (!moving) return tiles

  const dragRect = clampRectToGrid(
    { x: nextRect.x, y: nextRect.y, w: moving.w, h: moving.h },
    maxRows,
    moving.minW,
    moving.minH,
  )
  const dragging: LayoutTile = { ...moving, ...dragRect }
  const others = tiles.filter((tile) => tile.id !== dragId)

  const overlaps = others
    .filter((other) => !other.pinned && !other.restore && rectsOverlap(dragRect, other))
    .sort((a, b) => overlapArea(dragRect, b) - overlapArea(dragRect, a))

  const swapTarget = overlaps[0]
  const smallerArea = swapTarget
    ? Math.min(dragRect.w * dragRect.h, swapTarget.w * swapTarget.h)
    : 0
  const shouldSwap = !!swapTarget && smallerArea > 0
    && overlapArea(dragRect, swapTarget) >= smallerArea * 0.22

  const blockers: LayoutTile[] = [dragging]
  const relocated = new Map<string, LayoutTile>()

  for (const tile of others) {
    if (shouldSwap && tile.id === swapTarget!.id) {
      let slot = clampRectToGrid(
        { x: origin.x, y: origin.y, w: tile.w, h: tile.h },
        maxRows,
        tile.minW,
        tile.minH,
      )
      if (rectsOverlap(slot, dragRect)) {
        slot = findOpenSlot(tile, blockers, maxRows)
      }
      const placed = { ...tile, ...slot }
      relocated.set(tile.id, placed)
      blockers.push(placed)
      continue
    }

    if (tile.pinned || tile.restore) {
      relocated.set(tile.id, tile)
      blockers.push(tile)
      continue
    }

    if (rectsOverlap(tile, dragRect)) {
      const placed = { ...tile, ...findOpenSlot(tile, blockers, maxRows) }
      relocated.set(tile.id, placed)
      blockers.push(placed)
      continue
    }

    relocated.set(tile.id, tile)
    blockers.push(tile)
  }

  return tiles.map((tile) => {
    if (tile.id === dragId) return dragging
    return relocated.get(tile.id) ?? tile
  })
}

/**
 * Place a new tile. First widget fills the viewport; when the canvas is full,
 * split the largest unpinned tile so the new one can sit beside/below it.
 */
export function placeNewTile(
  tiles: LayoutTile[],
  id: string,
  type: WidgetType,
  defaults: WidgetSizeDefaults,
  maxRows?: number,
): { tile: LayoutTile; tiles: LayoutTile[] } {
  const rowsCap = maxRows && maxRows > 0 ? maxRows : undefined
  const { minW, minH } = defaults

  if (tiles.length === 0) {
    const h = rowsCap ?? defaults.h
    const tile: LayoutTile = {
      id,
      type,
      x: 0,
      y: 0,
      w: COLS,
      h: Math.max(minH, h),
      minW,
      minH,
    }
    return { tile, tiles: [tile] }
  }

  const fitted = findBestFit(tiles, id, type, defaults, rowsCap)
  const freeEnough = !tiles.some((tile) => rectsOverlap(fitted, tile))
  if (freeEnough && (!rowsCap || fitted.y + fitted.h <= rowsCap)) {
    // Prefer a roomy fill when there's a large empty region
    const roomy = rowsCap
      ? { ...fitted, ...clampRectToGrid({ ...fitted, w: Math.max(fitted.w, Math.min(defaults.w, COLS)), h: Math.max(fitted.h, Math.min(defaults.h, rowsCap)) }, rowsCap, minW, minH) }
      : fitted
    const stillFree = !tiles.some((tile) => rectsOverlap(roomy, tile))
    const tile = stillFree ? roomy : fitted
    return { tile, tiles: [...tiles, tile] }
  }

  if (!rowsCap) {
    return { tile: fitted, tiles: [...tiles, fitted] }
  }

  // Canvas is packed — split the largest movable tile to make room.
  const target = [...tiles]
    .filter((tile) => !tile.pinned && !tile.restore)
    .sort((a, b) => (b.w * b.h) - (a.w * a.h) || b.h - a.h)[0]

  if (!target) {
    const tile = { ...fitted, ...findOpenSlot({ ...fitted, id, type, minW, minH }, tiles, rowsCap) }
    return { tile, tiles: [...tiles, tile] }
  }

  const canSplitHorizontal = target.w >= minW + target.minW && target.w >= 4
  let nextTiles: LayoutTile[]
  let tile: LayoutTile

  if (canSplitHorizontal) {
    const leftW = Math.max(target.minW, Math.floor(target.w / 2))
    const rightW = target.w - leftW
    nextTiles = tiles.map((t) =>
      t.id === target.id ? { ...t, w: leftW } : t,
    )
    tile = {
      id,
      type,
      x: target.x + leftW,
      y: target.y,
      w: Math.max(minW, rightW),
      h: target.h,
      minW,
      minH,
    }
  } else {
    const topH = Math.max(target.minH, Math.floor(target.h / 2))
    const bottomH = target.h - topH
    nextTiles = tiles.map((t) =>
      t.id === target.id ? { ...t, h: topH } : t,
    )
    tile = {
      id,
      type,
      x: target.x,
      y: target.y + topH,
      w: target.w,
      h: Math.max(minH, bottomH),
      minW,
      minH,
    }
  }

  tile = { ...tile, ...clampRectToGrid(tile, rowsCap, minW, minH) }
  return { tile, tiles: [...nextTiles, tile] }
}

/**
 * Find the best position for a new tile by locating the largest empty
 * rectangle in the current layout. If no gap exists, appends at the bottom
 * (clamped to maxRows when provided).
 */
export function findBestFit(
  tiles: LayoutTile[],
  id: string,
  type: WidgetType,
  defaults: WidgetSizeDefaults,
  maxRows?: number,
): LayoutTile {
  const { minW, minH } = defaults
  const rowsCap = maxRows && maxRows > 0 ? maxRows : undefined

  if (tiles.length === 0) {
    const h = rowsCap ?? defaults.h
    return { id, type, x: 0, y: 0, w: COLS, h: Math.max(minH, h), minW, minH }
  }

  const occupiedBottom = Math.max(...tiles.map((tile) => tile.y + tile.h))
  const scanRows = rowsCap ?? occupiedBottom
  const grid: boolean[][] = Array.from({ length: scanRows }, () => Array(COLS).fill(false))
  for (const tile of tiles) {
    for (let y = tile.y; y < Math.min(tile.y + tile.h, scanRows); y++) {
      for (let x = tile.x; x < Math.min(tile.x + tile.w, COLS); x++) {
        grid[y]![x] = true
      }
    }
  }

  let bestArea = 0
  let best = {
    x: 0,
    y: rowsCap ? Math.max(0, rowsCap - Math.min(defaults.h, rowsCap)) : occupiedBottom,
    w: COLS,
    h: rowsCap ? Math.min(defaults.h, rowsCap) : defaults.h,
  }

  for (let sy = 0; sy < scanRows; sy++) {
    for (let sx = 0; sx < COLS; sx++) {
      if (grid[sy]![sx]) continue
      let maxW = COLS - sx
      for (let ey = sy; ey < scanRows; ey++) {
        for (let ex = sx; ex < sx + maxW; ex++) {
          if (grid[ey]![ex]) { maxW = ex - sx; break }
        }
        if (maxW < minW) break
        const h = ey - sy + 1
        if (h < minH) continue
        const area = maxW * h
        if (area > bestArea) { bestArea = area; best = { x: sx, y: sy, w: maxW, h } }
      }
    }
  }

  const placed = { id, type, ...best, minW, minH }
  return rowsCap ? { ...placed, ...clampRectToGrid(placed, rowsCap, minW, minH) } : placed
}

export function pixelsToGridRect(
  pixels: PixelRect,
  cw: number,
  minW = 1,
  minH = 1,
  maxRows?: number,
  rowPx = ROW_PX,
): GridRect {
  const unitX = cw + GRID_MARGIN
  const unitY = rowPx + GRID_MARGIN
  const x = Math.round(pixels.left / unitX)
  const y = Math.round(pixels.top / unitY)
  const w = Math.max(minW, Math.round((pixels.width + GRID_MARGIN) / unitX))
  const h = Math.max(minH, Math.round((pixels.height + GRID_MARGIN) / unitY))
  const rect = {
    x: Math.min(Math.max(0, x), COLS - w),
    y: Math.max(0, y),
    w: Math.min(w, COLS),
    h,
  }
  return maxRows ? clampRectToGrid(rect, maxRows, minW, minH) : rect
}

export function snapDragRect(
  tile: LayoutTile,
  deltaX: number,
  deltaY: number,
  cw: number,
  maxRows?: number,
  rowPx = ROW_PX,
): GridRect {
  const base = rectToPixels(tile, cw, rowPx)
  const snapped = pixelsToGridRect(
    {
      left: base.left + deltaX,
      top: base.top + deltaY,
      width: base.width,
      height: base.height,
    },
    cw,
    tile.minW,
    tile.minH,
    maxRows,
    rowPx,
  )
  const next = {
    ...snapped,
    w: tile.w,
    h: tile.h,
  }
  return maxRows ? clampRectToGrid(next, maxRows, tile.minW, tile.minH) : next
}
