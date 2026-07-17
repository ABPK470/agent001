import type { ViewConfig } from "../types"
import type { LayoutTile } from "./grid-math"
import { normalizeTiles } from "./grid-math"
import { WIDGET_DEFAULTS } from "./widget-layout-defaults"

export type { LayoutTile }

export interface WorkspaceView {
  id: string
  name: string
  tiles: LayoutTile[]
}

export const LAYOUT_DOC_VERSION = 2

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
  }
}

export function viewFromWire(view: ViewConfig): WorkspaceView {
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
  return {
    id: view.id,
    name: view.name,
    tiles: normalizeTiles(tiles, WIDGET_DEFAULTS),
  }
}

export function workspaceViewsFromWire(views: ViewConfig[]): WorkspaceView[] {
  return views.map(viewFromWire)
}
