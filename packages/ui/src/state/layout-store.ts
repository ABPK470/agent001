/**
 * Workspace layout store — views, tiles, drag/resize state.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import {
  clampRectToGrid,
  compactDown,
  normalizeTiles,
  placeNewTile,
  type GridRect,
} from "../lib/grid-math"
import { WIDGET_DEFAULTS } from "../lib/widget-layout-defaults"
import type { WidgetSizeDefaults } from "../lib/widget-layout-defaults"
import type { WorkspaceView } from "../lib/workspace-view"
import type { ViewConfig, WidgetType } from "../types"
import { randomId } from "../lib/util"

export { WIDGET_DEFAULTS }

const DEFAULT_VIEW_ID = "default"

export function makeDefaultView(): WorkspaceView {
  return {
    id: DEFAULT_VIEW_ID,
    name: "Main",
    tiles: [],
  }
}

/** Drop widgets removed from the catalogue so saved layouts stay valid. */
export function pruneUnknownWidgets(views: ViewConfig[]): ViewConfig[] {
  return views.map((view) => {
    const widgets = view.widgets.filter((widget) => widget.type in WIDGET_DEFAULTS)
    const widgetIds = new Set(widgets.map((widget) => widget.id))
    return {
      ...view,
      widgets,
      layouts: {
        ...view.layouts,
        lg: (view.layouts["lg"] ?? []).filter((item) => widgetIds.has(item.i)),
      },
    }
  })
}

function pruneWorkspaceViews(views: WorkspaceView[], maxRows?: number): WorkspaceView[] {
  return views
    .map((view) => ({
      ...view,
      tiles: view.tiles.filter((tile) => tile.type in WIDGET_DEFAULTS),
    }))
    .map((view) => ({
      ...view,
      tiles: normalizeTiles(view.tiles, WIDGET_DEFAULTS, maxRows),
    }))
}

interface LayoutState {
  views: WorkspaceView[]
  activeViewId: string
  focusedTileId: string | null
  enteringTileIds: string[]
  /**
   * Exclusive maximize: this tile fills the canvas; siblings keep their
   * saved geometry and are not painted until restore.
   */
  soloTileId: string | null
  /** Latest measured viewport row budget for the active canvas. */
  viewportRows: number

  setActiveView: (id: string) => void
  addView: (name: string) => string
  removeView: (id: string) => void
  renameView: (id: string, name: string) => void

  addWidget: (viewId: string, type: WidgetType) => void
  removeWidget: (viewId: string, tileId: string) => void
  updateTileRect: (viewId: string, tileId: string, rect: GridRect) => void
  updateTiles: (viewId: string, tiles: WorkspaceView["tiles"]) => void
  setViewportRows: (rows: number) => void
  setTilePinned: (viewId: string, tileId: string, pinned: boolean) => void
  toggleTileMaximized: (viewId: string, tileId: string) => void

  setFocusedTile: (tileId: string | null) => void
  clearEntering: (tileId: string) => void
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      views: [makeDefaultView()],
      activeViewId: DEFAULT_VIEW_ID,
      focusedTileId: null,
      enteringTileIds: [],
      soloTileId: null,
      viewportRows: 24,

      setActiveView: (id) => set({ activeViewId: id, soloTileId: null }),

      addView: (name) => {
        const id = randomId()
        set((s) => ({
          views: [...s.views, { id, name, tiles: [] }],
          activeViewId: id,
          soloTileId: null,
        }))
        return id
      },

      removeView: (id) => set((s) => {
        const filtered = s.views.filter((view) => view.id !== id)
        if (filtered.length === 0) filtered.push(makeDefaultView())
        return {
          views: filtered,
          activeViewId: s.activeViewId === id ? filtered[0]!.id : s.activeViewId,
          soloTileId: null,
        }
      }),

      renameView: (id, name) => set((s) => ({
        views: s.views.map((view) => view.id === id ? { ...view, name } : view),
      })),

      addWidget: (viewId, type) => set((s) => {
        const view = s.views.find((v) => v.id === viewId)
        if (!view) return s
        const defaults = WIDGET_DEFAULTS[type] as WidgetSizeDefaults
        const id = randomId()
        const baseTiles = s.soloTileId
          ? view.tiles
          : view.tiles
        const { tile, tiles } = placeNewTile(baseTiles, id, type, defaults, s.viewportRows)
        return {
          views: s.views.map((v) =>
            v.id === viewId ? { ...v, tiles: normalizeTiles(tiles, WIDGET_DEFAULTS, s.viewportRows) } : v,
          ),
          enteringTileIds: [...s.enteringTileIds, tile.id],
          soloTileId: null,
        }
      }),

      removeWidget: (viewId, tileId) => set((s) => ({
        views: s.views.map((view) =>
          view.id === viewId
            ? {
              ...view,
              tiles: normalizeTiles(
                view.tiles.filter((tile) => tile.id !== tileId),
                WIDGET_DEFAULTS,
                s.viewportRows,
              ),
            }
            : view,
        ),
        focusedTileId: s.focusedTileId === tileId ? null : s.focusedTileId,
        enteringTileIds: s.enteringTileIds.filter((id) => id !== tileId),
        soloTileId: s.soloTileId === tileId ? null : s.soloTileId,
      })),

      updateTileRect: (viewId, tileId, rect) => set((s) => {
        if (s.soloTileId) return s
        return {
          views: s.views.map((view) => {
            if (view.id !== viewId) return view
            const nextTiles = view.tiles.map((tile) => {
              if (tile.id !== tileId || tile.pinned) return tile
              return {
                ...tile,
                ...clampRectToGrid(rect, s.viewportRows, tile.minW, tile.minH),
              }
            })
            return {
              ...view,
              tiles: normalizeTiles(nextTiles, WIDGET_DEFAULTS, s.viewportRows),
            }
          }),
        }
      }),

      updateTiles: (viewId, tiles) => set((s) => {
        if (s.soloTileId) return s
        return {
          views: s.views.map((view) =>
            view.id === viewId
              ? { ...view, tiles: normalizeTiles(tiles, WIDGET_DEFAULTS, s.viewportRows) }
              : view,
          ),
        }
      }),

      setViewportRows: (rows) => {
        const nextRows = Math.max(1, rows)
        if (get().viewportRows === nextRows) return
        set((s) => ({
          viewportRows: nextRows,
          views: s.views.map((view) => ({
            ...view,
            tiles: normalizeTiles(view.tiles, WIDGET_DEFAULTS, nextRows),
          })),
        }))
      },

      setTilePinned: (viewId, tileId, pinned) => set((s) => ({
        views: s.views.map((view) => {
          if (view.id !== viewId) return view
          return {
            ...view,
            tiles: view.tiles.map((tile) =>
              tile.id === tileId ? { ...tile, pinned } : tile,
            ),
          }
        }),
      })),

      toggleTileMaximized: (_viewId, tileId) => set((s) => ({
        soloTileId: s.soloTileId === tileId ? null : tileId,
        focusedTileId: tileId,
      })),

      setFocusedTile: (tileId) => set({ focusedTileId: tileId }),

      clearEntering: (tileId) => set((s) => ({
        enteringTileIds: s.enteringTileIds.filter((id) => id !== tileId),
      })),
    }),
    {
      name: "mia-layout",
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<LayoutState>
        const views = persisted.views?.length
          ? pruneWorkspaceViews(persisted.views, currentState.viewportRows)
          : currentState.views
        return {
          ...currentState,
          ...persisted,
          views,
          focusedTileId: null,
          enteringTileIds: [],
          soloTileId: null,
          viewportRows: currentState.viewportRows,
        }
      },
      partialize: (state) => ({
        views: state.views,
        activeViewId: state.activeViewId,
      }),
    },
  ),
)

/** Compact unpinned tiles after a remove — optional helper for callers. */
export function compactView(viewId: string): void {
  const { views, updateTiles } = useLayoutStore.getState()
  const view = views.find((v) => v.id === viewId)
  if (!view) return
  updateTiles(viewId, compactDown(view.tiles))
}
