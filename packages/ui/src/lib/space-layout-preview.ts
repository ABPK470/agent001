/**
 * Project a workspace view split into fixed-bounds leaf boxes for the
 * tab-strip Space preview. Pure — ratios only; no React / store.
 */

import type { WidgetType } from "../types"
import type { GridRect } from "./grid-math"
import { layoutLeaves, type SplitNode } from "./split-tree"

export type SpacePreviewTile = {
  id: string
  type: WidgetType
}

export type SpacePreviewLeaf = {
  tileId: string
  type: WidgetType | null
  rect: GridRect
}

/** Unit canvas for the fixed preview shell (percent-friendly). */
export const SPACE_PREVIEW_BOUNDS: GridRect = { x: 0, y: 0, w: 100, h: 56 }

/**
 * Map `view.split` + tiles onto a fixed preview canvas.
 * Empty / null split → one full-bleed empty leaf.
 */
export function projectSpaceLayoutPreview(
  split: SplitNode | null,
  tiles: readonly SpacePreviewTile[],
  bounds: GridRect = SPACE_PREVIEW_BOUNDS,
): SpacePreviewLeaf[] {
  const typeById = new Map(tiles.map((tile) => [tile.id, tile.type] as const))

  if (!split || tiles.length === 0) {
    return [{ tileId: "__empty__", type: null, rect: { ...bounds } }]
  }

  const leaves = layoutLeaves(split, bounds)
  if (leaves.length === 0) {
    return [{ tileId: "__empty__", type: null, rect: { ...bounds } }]
  }

  return leaves.map((leaf) => ({
    tileId: leaf.tileId,
    type: typeById.get(leaf.tileId) ?? null,
    rect: leaf.rect,
  }))
}

/** CSS % placement relative to `bounds` (default preview canvas). */
export function spacePreviewLeafStyle(
  rect: GridRect,
  bounds: GridRect = SPACE_PREVIEW_BOUNDS,
): { left: string; top: string; width: string; height: string } {
  const w = Math.max(1, bounds.w)
  const h = Math.max(1, bounds.h)
  return {
    left: `${(rect.x / w) * 100}%`,
    top: `${(rect.y / h) * 100}%`,
    width: `${(rect.w / w) * 100}%`,
    height: `${(rect.h / h) * 100}%`,
  }
}

/**
 * Center the preview under a tab, clamped so the shell stays inside the
 * cluster (or viewport) when the tab sits near an edge.
 */
export function clampSpacePreviewAnchor(
  tabCenterPx: number,
  previewWidthPx: number,
  clusterWidthPx: number,
): number {
  if (clusterWidthPx <= 0) return tabCenterPx
  if (clusterWidthPx <= previewWidthPx) return clusterWidthPx / 2
  const half = previewWidthPx / 2
  return Math.max(half, Math.min(tabCenterPx, clusterWidthPx - half))
}
