import type { ViewConfig, ViewSplitNode } from "../types"
import { COLS, type LayoutTile } from "./grid-math"
import { WIDGET_DEFAULTS } from "./widget-layout-defaults"
import {
  ensureTreeForTiles,
  projectTiles,
  treeFromRects,
  type SplitNode,
} from "./split-tree"

export type { LayoutTile }

export interface WorkspaceView {
  id: string
  name: string
  tiles: LayoutTile[]
  /** Nested split tree; null when the view has no widgets. */
  split: SplitNode | null
}

export const LAYOUT_DOC_VERSION = 3

function asSplitNode(node: ViewSplitNode | null | undefined): SplitNode | null {
  if (!node) return null
  if (node.kind === "leaf") return { kind: "leaf", tileId: node.tileId }
  return {
    kind: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: asSplitNode(node.a)!,
    b: asSplitNode(node.b)!,
  }
}

function toWireSplit(node: SplitNode | null): ViewSplitNode | null {
  if (!node) return null
  if (node.kind === "leaf") return { kind: "leaf", tileId: node.tileId }
  return {
    kind: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: toWireSplit(node.a)!,
    b: toWireSplit(node.b)!,
  }
}

/** Re-project leaf geometry from the split tree onto tile metadata. */
export function syncViewGeometry(
  view: WorkspaceView,
  rows: number,
  cols = COLS,
): WorkspaceView {
  const split = ensureTreeForTiles(view.split, view.tiles, cols, rows)
  return {
    ...view,
    split,
    tiles: projectTiles(split, view.tiles, cols, rows),
  }
}

export function viewToWire(view: WorkspaceView): ViewConfig {
  return {
    id: view.id,
    name: view.name,
    widgets: view.tiles.map((tile) => ({ id: tile.id, type: tile.type })),
    layouts: {
      lg: view.tiles.map((tile) => ({
        i: tile.id,
        x: tile.x,
        y: tile.y,
        w: tile.w,
        h: tile.h,
        minW: tile.minW,
        minH: tile.minH,
        ...(tile.pinned ? { pinned: true } : {}),
      })),
    },
    split: toWireSplit(view.split),
  }
}

export function viewFromWire(view: ViewConfig, rows = 24): WorkspaceView {
  const layoutById = new Map((view.layouts["lg"] ?? []).map((item) => [item.i, item]))
  const tiles: LayoutTile[] = view.widgets.map((widget) => {
    const layout = layoutById.get(widget.id)
    const defaults = WIDGET_DEFAULTS[widget.type]
    return {
      id: widget.id,
      type: widget.type,
      x: layout?.x ?? 0,
      y: layout?.y ?? 0,
      w: layout?.w ?? defaults.w,
      h: layout?.h ?? defaults.h,
      minW: layout?.minW ?? defaults.minW,
      minH: layout?.minH ?? defaults.minH,
      ...(layout?.pinned ? { pinned: true } : {}),
    }
  })

  const fromWire = asSplitNode(view.split ?? null)
  const split = fromWire
    ? ensureTreeForTiles(fromWire, tiles, COLS, rows)
    : treeFromRects(tiles, COLS, rows)

  return syncViewGeometry({ id: view.id, name: view.name, tiles, split }, rows)
}

export function workspaceViewsFromWire(views: ViewConfig[], rows = 24): WorkspaceView[] {
  return views.map((view) => viewFromWire(view, rows))
}
