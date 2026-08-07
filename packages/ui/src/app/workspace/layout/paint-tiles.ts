/**
 * Canvas paint plan for maximize / zen restore.
 *
 * Maximize and zen must never drop sibling tiles from the React tree — only
 * change display geometry and hide flags. Filtering unmounts live widgets.
 */

import { COLS, type LayoutTile } from "../../../lib/grid-math.js"
import { projectTiles, type SplitNode } from "../../../lib/split-tree.js"

export interface PaintedTile {
  /** Stable layout identity (for key + source lookup). */
  tile: LayoutTile
  /** Absolute grid rect used for positioning this paint. */
  display: LayoutTile
  /** This tile fills the canvas (solo maximize) or is a zen visible pane. */
  solo: boolean
  /** Sibling under solo/zen — stay mounted, not interactive. */
  soloHidden: boolean
}

export type PaintTilesOptions = {
  soloTileId: string | null
  maxRows: number
  /** When set, paints the zen immersion set (1–2) instead of plain solo. */
  zenSet?: readonly string[] | null
  /** Focused zen member — used when narrow collapses to one pane. */
  focusedTileId?: string | null
  /** Narrow canvas: show only the focused zen tile. */
  zenNarrow?: boolean
  /** Session-only companions not on the Space projection. */
  zenExtraTiles?: readonly LayoutTile[] | null
  /** Ephemeral zen split — preferred over fixed 50/50. */
  zenSplit?: SplitNode | null
  /** Live resize preview geometry for zen members (session-local). */
  zenDisplayOverrides?: readonly LayoutTile[] | null
}

/**
 * Always returns one entry per projected (+ zen-extra) tile.
 * Zen / solo change display geometry; others stay mounted and hidden.
 */
export function paintTilesForCanvas(
  projected: readonly LayoutTile[],
  soloTileIdOrOptions: string | null | PaintTilesOptions,
  maxRowsArg?: number,
): PaintedTile[] {
  const options: PaintTilesOptions =
    soloTileIdOrOptions !== null &&
    typeof soloTileIdOrOptions === "object" &&
    !Array.isArray(soloTileIdOrOptions)
      ? soloTileIdOrOptions
      : {
          soloTileId: soloTileIdOrOptions as string | null,
          maxRows: maxRowsArg ?? 24,
        }

  const {
    soloTileId,
    maxRows,
    zenSet = null,
    focusedTileId = null,
    zenNarrow = false,
    zenExtraTiles = null,
    zenSplit = null,
    zenDisplayOverrides = null,
  } = options

  const extras = zenExtraTiles ?? []
  const allTiles = extras.length === 0 ? projected : [...projected, ...extras]

  if (zenSet && zenSet.length > 0) {
    return paintZen(
      allTiles,
      zenSet,
      focusedTileId,
      zenNarrow,
      maxRows,
      zenSplit,
      zenDisplayOverrides,
    )
  }

  if (!soloTileId) {
    return allTiles.map((tile) => ({
      tile,
      display: tile,
      solo: false,
      soloHidden: false,
    }))
  }

  return allTiles.map((tile) => {
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

function paintZen(
  allTiles: readonly LayoutTile[],
  zenSet: readonly string[],
  focusedTileId: string | null,
  zenNarrow: boolean,
  maxRows: number,
  zenSplit: SplitNode | null,
  zenDisplayOverrides: readonly LayoutTile[] | null,
): PaintedTile[] {
  const visibleIds =
    zenNarrow || zenSet.length === 1
      ? [
          focusedTileId && zenSet.includes(focusedTileId)
            ? focusedTileId
            : zenSet[0]!,
        ]
      : zenSet.slice(0, 2)

  const sessionTiles = allTiles.filter((tile) => zenSet.includes(tile.id))
  const projectedById = new Map<string, LayoutTile>()
  if (zenDisplayOverrides) {
    for (const tile of zenDisplayOverrides) {
      if (zenSet.includes(tile.id)) projectedById.set(tile.id, tile)
    }
  } else if (zenSplit && visibleIds.length > 1) {
    for (const tile of projectTiles(zenSplit, sessionTiles, COLS, maxRows)) {
      projectedById.set(tile.id, tile)
    }
  }

  const half = Math.floor(COLS / 2)

  return allTiles.map((tile) => {
    const index = visibleIds.indexOf(tile.id)
    if (index < 0) {
      return {
        tile,
        display: tile,
        solo: false,
        soloHidden: true,
      }
    }
    if (visibleIds.length === 1) {
      return {
        tile,
        display: { ...tile, x: 0, y: 0, w: COLS, h: maxRows },
        solo: true,
        soloHidden: false,
      }
    }
    const fromSplit = projectedById.get(tile.id)
    if (fromSplit) {
      return {
        tile,
        display: { ...tile, ...fromSplit, id: tile.id, type: tile.type },
        // Pair immersion — not maximize-solo; drag/resize stay unlocked.
        solo: false,
        soloHidden: false,
      }
    }
    return {
      tile,
      display: {
        ...tile,
        x: index === 0 ? 0 : half,
        y: 0,
        w: index === 0 ? half : COLS - half,
        h: maxRows,
      },
      solo: false,
      soloHidden: false,
    }
  })
}
