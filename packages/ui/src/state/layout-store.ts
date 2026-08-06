/**
 * Workspace layout store — views, split tree, projected tiles.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { COLS } from "../lib/grid-math"
import {
  projectTiles,
  removeLeaf,
  reparentLeaf,
  setSplitRatio,
  splitLargestLeaf,
  type DropZone,
  type SplitNode,
  type SplitPath,
} from "../lib/split-tree"
import { WIDGET_DEFAULTS } from "../lib/widget-layout-defaults"
import type { WidgetSizeDefaults } from "../lib/widget-layout-defaults"
import {
  syncViewGeometry,
  type WorkspaceView,
} from "../lib/workspace-view"
import {
  mergeProductSpaces,
  migrateSpaceId,
  reapplyProductSpaceLayouts,
  SPACE_LAYOUT_VERSION,
  resetSpaceView,
  spaceById,
  spaceByIndex,
  type SpaceId,
} from "../lib/spaces"
import { neighborTileForFocus, type FocusArrowKey } from "../lib/tile-focus-neighbor"
import { firstTileIdForWidgetType } from "../lib/focus-widget-tile"
import type { ViewConfig, WidgetType } from "../types"
import { randomId } from "../lib/util"
import { clearEventStreamPrefs } from "../lib/event-stream-prefs"

export { WIDGET_DEFAULTS }

const DEFAULT_VIEW_ID = "default"

export function makeDefaultView(): WorkspaceView {
  return {
    id: DEFAULT_VIEW_ID,
    name: "Main",
    tiles: [],
    split: null,
  }
}

/** Drop widgets removed from the catalogue so saved layouts stay valid. */
export function pruneUnknownWidgets(views: ViewConfig[]): ViewConfig[] {
  return views.map((view) => {
    const widgets = view.widgets.filter((widget) => widget.type in WIDGET_DEFAULTS)
    const widgetIds = new Set(widgets.map((widget) => widget.id))
    const pruneSplit = (node: ViewConfig["split"]): ViewConfig["split"] => {
      if (!node) return null
      if (node.kind === "leaf") return widgetIds.has(node.tileId) ? node : null
      const a = pruneSplit(node.a)
      const b = pruneSplit(node.b)
      if (!a && !b) return null
      if (!a) return b
      if (!b) return a
      return { ...node, a, b }
    }
    return {
      ...view,
      widgets,
      layouts: {
        ...view.layouts,
        lg: (view.layouts["lg"] ?? []).filter((item) => widgetIds.has(item.i)),
      },
      split: pruneSplit(view.split ?? null),
    }
  })
}

function pruneWorkspaceViews(views: WorkspaceView[], maxRows?: number): WorkspaceView[] {
  const rows = Math.max(1, maxRows ?? 24)
  return views
    .map((view) => ({
      ...view,
      tiles: view.tiles.filter((tile) => tile.type in WIDGET_DEFAULTS),
      split: view.split ?? null,
    }))
    .map((view) => syncViewGeometry(view, rows))
}

function withProjected(
  view: WorkspaceView,
  split: SplitNode | null,
  rows: number,
): WorkspaceView {
  return {
    ...view,
    split,
    tiles: projectTiles(split, view.tiles, COLS, rows),
  }
}

interface LayoutState {
  views: WorkspaceView[]
  activeViewId: string
  focusedTileId: string | null
  enteringTileIds: string[]
  /**
   * Exclusive maximize: this tile fills the canvas. Siblings stay mounted at
   * their tree geometry and are paint-hidden until restore (no remount).
   */
  soloTileId: string | null
  /**
   * Zen / focus: edge-to-edge debugger — hides workspace toolbar and widget
   * header. Implies solo for the same tile.
   */
  zenTileId: string | null
  /** Latest measured viewport row budget for the active canvas. */
  viewportRows: number
  /** Tracks curated Space layout recipe; mismatch rebuilds product Spaces. */
  spaceLayoutVersion: number

  setActiveView: (id: string) => void
  addView: (name: string) => string
  removeView: (id: string) => void
  renameView: (id: string, name: string) => void
  /** Move a view tab to a new index in the tab strip. */
  reorderViews: (viewId: string, toIndex: number) => void

  addWidget: (viewId: string, type: WidgetType) => void
  removeWidget: (viewId: string, tileId: string) => void
  /** Commit a new split tree (geometry re-projected onto tiles). */
  commitSplit: (viewId: string, split: SplitNode | null) => void
  setSplitRatioAt: (viewId: string, path: SplitPath, ratio: number) => void
  reparentTile: (viewId: string, dragId: string, targetId: string, zone: DropZone) => void
  setViewportRows: (rows: number) => void
  setTilePinned: (viewId: string, tileId: string, pinned: boolean) => void
  toggleTileMaximized: (viewId: string, tileId: string) => void
  toggleTileZen: (viewId: string, tileId: string) => void
  exitTileZen: () => void

  setFocusedTile: (tileId: string | null) => void
  clearEntering: (tileId: string) => void

  /** Seed product Spaces (Observe / Reconcile / Bridge / Agent) if missing. */
  ensureProductSpaces: () => void
  /** Activate a product Space by id or 1–5 index; focuses first tile. */
  callSpace: (space: SpaceId | number) => void
  /** Rebuild the active product Space to its curated default. */
  resetActiveSpace: () => void
  /** Move keyboard focus to a geometric neighbor tile. */
  focusTileNeighbor: (key: FocusArrowKey) => void
  /** Ensure widget types exist on a view (add missing only). */
  ensureWidgets: (viewId: string, types: readonly WidgetType[]) => void
  /**
   * Focus a widget type on the active view — clears solo/zen.
   * Does not maximize (operator uses M).
   */
  focusWidgetType: (type: WidgetType) => void
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      views: mergeProductSpaces([makeDefaultView()], 24),
      activeViewId: DEFAULT_VIEW_ID,
      focusedTileId: null,
      enteringTileIds: [],
      soloTileId: null,
      zenTileId: null,
      viewportRows: 24,
      spaceLayoutVersion: SPACE_LAYOUT_VERSION,

      setActiveView: (id) => set((s) => {
        const view = s.views.find((v) => v.id === id)
        return {
          activeViewId: id,
          soloTileId: null,
          zenTileId: null,
          focusedTileId: view?.tiles[0]?.id ?? null,
        }
      }),

      addView: (name) => {
        const id = randomId()
        set((s) => ({
          views: [...s.views, { id, name, tiles: [], split: null }],
          activeViewId: id,
          soloTileId: null,
          zenTileId: null,
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
          zenTileId: null,
        }
      }),

      renameView: (id, name) => set((s) => ({
        views: s.views.map((view) => view.id === id ? { ...view, name } : view),
      })),

      reorderViews: (viewId, toIndex) => set((s) => {
        const fromIndex = s.views.findIndex((view) => view.id === viewId)
        if (fromIndex < 0) return s
        const clamped = Math.max(0, Math.min(toIndex, s.views.length - 1))
        if (fromIndex === clamped) return s
        const next = [...s.views]
        const [moved] = next.splice(fromIndex, 1)
        if (!moved) return s
        next.splice(clamped, 0, moved)
        return { views: next }
      }),

      addWidget: (viewId, type) => set((s) => {
        const view = s.views.find((v) => v.id === viewId)
        if (!view) return s
        const defaults = WIDGET_DEFAULTS[type] as WidgetSizeDefaults
        const id = randomId()
        const meta = {
          id,
          type,
          x: 0,
          y: 0,
          w: defaults.w,
          h: defaults.h,
          minW: defaults.minW,
          minH: defaults.minH,
        }
        const tiles = [...view.tiles, meta]
        const split = splitLargestLeaf(view.split, id, COLS, s.viewportRows)
        return {
          views: s.views.map((v) =>
            v.id === viewId ? withProjected({ ...v, tiles }, split, s.viewportRows) : v,
          ),
          enteringTileIds: [...s.enteringTileIds, id],
          soloTileId: null,
          zenTileId: null,
        }
      }),

      removeWidget: (viewId, tileId) => {
        clearEventStreamPrefs(tileId)
        set((s) => ({
        views: s.views.map((view) => {
          if (view.id !== viewId) return view
          const tiles = view.tiles.filter((tile) => tile.id !== tileId)
          const split = removeLeaf(view.split, tileId)
          return withProjected({ ...view, tiles }, split, s.viewportRows)
        }),
        focusedTileId: s.focusedTileId === tileId ? null : s.focusedTileId,
        enteringTileIds: s.enteringTileIds.filter((id) => id !== tileId),
        soloTileId: s.soloTileId === tileId ? null : s.soloTileId,
        zenTileId: s.zenTileId === tileId ? null : s.zenTileId,
      }))
      },

      commitSplit: (viewId, split) => set((s) => {
        if (s.soloTileId) return s
        return {
          views: s.views.map((view) =>
            view.id === viewId ? withProjected(view, split, s.viewportRows) : view,
          ),
        }
      }),

      setSplitRatioAt: (viewId, path, ratio) => set((s) => {
        if (s.soloTileId) return s
        return {
          views: s.views.map((view) => {
            if (view.id !== viewId || !view.split) return view
            return withProjected(view, setSplitRatio(view.split, path, ratio), s.viewportRows)
          }),
        }
      }),

      reparentTile: (viewId, dragId, targetId, zone) => set((s) => {
        if (s.soloTileId) return s
        return {
          views: s.views.map((view) => {
            if (view.id !== viewId || !view.split) return view
            const drag = view.tiles.find((tile) => tile.id === dragId)
            const target = view.tiles.find((tile) => tile.id === targetId)
            if (!drag || !target || drag.pinned || target.pinned) return view
            const next = reparentLeaf(view.split, dragId, targetId, zone)
            return withProjected(view, next, s.viewportRows)
          }),
        }
      }),

      setViewportRows: (rows) => {
        const nextRows = Math.max(1, rows)
        if (get().viewportRows === nextRows) return
        set((s) => ({
          viewportRows: nextRows,
          views: s.views.map((view) => syncViewGeometry(view, nextRows)),
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

      toggleTileMaximized: (_viewId, tileId) => set((s) => {
        const restoring = s.soloTileId === tileId
        return {
          soloTileId: restoring ? null : tileId,
          zenTileId: restoring || s.zenTileId === tileId ? null : s.zenTileId,
          focusedTileId: tileId,
        }
      }),

      toggleTileZen: (_viewId, tileId) => set((s) => {
        if (s.zenTileId === tileId) {
          return { zenTileId: null, focusedTileId: tileId }
        }
        return {
          soloTileId: tileId,
          zenTileId: tileId,
          focusedTileId: tileId,
        }
      }),

      exitTileZen: () => set({ zenTileId: null }),

      setFocusedTile: (tileId) => set({ focusedTileId: tileId }),

      clearEntering: (tileId) => set((s) => ({
        enteringTileIds: s.enteringTileIds.filter((id) => id !== tileId),
      })),

      ensureProductSpaces: () => set((s) => ({
        views: mergeProductSpaces(s.views, s.viewportRows),
      })),

      callSpace: (space) => {
        const def = typeof space === "number" ? spaceByIndex(space) : spaceById(space)
        if (!def) return
        set((s) => {
          const views = mergeProductSpaces(s.views, s.viewportRows)
          const view = views.find((v) => v.id === def.id)
          return {
            views,
            activeViewId: def.id,
            soloTileId: null,
            zenTileId: null,
            focusedTileId: view?.tiles[0]?.id ?? null,
          }
        })
      },

      resetActiveSpace: () => set((s) => {
        const def = spaceById(s.activeViewId)
        if (!def) return s
        const views = resetSpaceView(s.views, def.id, s.viewportRows)
        const view = views.find((v) => v.id === def.id)
        return {
          views,
          soloTileId: null,
          zenTileId: null,
          focusedTileId: view?.tiles[0]?.id ?? null,
        }
      }),

      focusTileNeighbor: (key) => set((s) => {
        const view = s.views.find((v) => v.id === s.activeViewId)
        if (!view || view.tiles.length === 0) return s
        // No focus yet — take the first tile, then the next chord moves.
        if (!s.focusedTileId) {
          return { focusedTileId: view.tiles[0]!.id }
        }
        const nextId = neighborTileForFocus(view.tiles, s.focusedTileId, key)
        if (!nextId) return s
        return { focusedTileId: nextId }
      }),

      ensureWidgets: (viewId, types) => {
        for (const type of types) {
          const view = get().views.find((v) => v.id === viewId)
          if (!view) return
          if (view.tiles.some((tile) => tile.type === type)) continue
          get().addWidget(viewId, type)
        }
      },

      focusWidgetType: (type) => set((s) => {
        const view = s.views.find((v) => v.id === s.activeViewId)
        if (!view) return s
        const tileId = firstTileIdForWidgetType(view.tiles, type)
        if (!tileId) return s
        return {
          focusedTileId: tileId,
          soloTileId: null,
          zenTileId: null,
        }
      }),
    }),
    {
      name: "mia-layout",
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<LayoutState> & {
          spaceLayoutVersion?: number
        }
        const rawViews = persisted.views?.length
          ? pruneWorkspaceViews(persisted.views, currentState.viewportRows)
          : currentState.views
        const version = persisted.spaceLayoutVersion ?? 0
        const views =
          version === SPACE_LAYOUT_VERSION
            ? mergeProductSpaces(rawViews, currentState.viewportRows)
            : reapplyProductSpaceLayouts(
                mergeProductSpaces(rawViews, currentState.viewportRows),
                currentState.viewportRows,
              )
        const wantedActiveId = persisted.activeViewId
          ? migrateSpaceId(persisted.activeViewId)
          : currentState.activeViewId
        const activeViewId =
          views.some((view) => view.id === wantedActiveId)
            ? wantedActiveId
            : currentState.activeViewId
        return {
          ...currentState,
          ...persisted,
          views,
          activeViewId,
          focusedTileId: null,
          enteringTileIds: [],
          soloTileId: null,
          zenTileId: null,
          viewportRows: currentState.viewportRows,
          spaceLayoutVersion: SPACE_LAYOUT_VERSION,
        }
      },
      partialize: (state) => ({
        views: state.views,
        activeViewId: state.activeViewId,
        spaceLayoutVersion: state.spaceLayoutVersion,
      }),
    },
  ),
)
