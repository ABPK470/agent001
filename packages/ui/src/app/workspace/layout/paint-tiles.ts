/**
 * Canvas paint plan for maximize/restore.
 *
 * Maximize must never drop sibling tiles from the React tree — only change
 * display geometry and hide flags. Filtering to one tile unmounts Pipelines /
 * Chat / Trace and makes restore lag under real data.
 */

import { COLS, type LayoutTile } from "../../../lib/grid-math.js"

export interface PaintedTile {
  /** Stable layout identity (for key + source lookup). */
  tile: LayoutTile
  /** Absolute grid rect used for positioning this paint. */
  display: LayoutTile
  /** This tile fills the canvas (solo maximize). */
  solo: boolean
  /** Sibling under solo maximize — stay mounted, not interactive. */
  soloHidden: boolean
}

/**
 * Always returns one entry per projected tile (same ids, same order).
 * When `soloTileId` is set, that tile gets full-canvas display; others keep
 * their projected geometry and are marked `soloHidden`.
 */
export function paintTilesForCanvas(
  projected: readonly LayoutTile[],
  soloTileId: string | null,
  maxRows: number,
): PaintedTile[] {
  if (!soloTileId) {
    return projected.map((tile) => ({
      tile,
      display: tile,
      solo: false,
      soloHidden: false,
    }))
  }

  return projected.map((tile) => {
    if (tile.id === soloTileId) {
      return {
        tile,
        display: { ...tile, x: 0, y: 0, w: COLS, h: maxRows },
        solo: true,
        soloHidden: false,
      }
    }
    return {
      tile,
      display: tile,
      solo: false,
      soloHidden: true,
    }
  })
}
