/**
 * Workspace layout store — views, split tree, projected tiles.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { canOpenWidget } from "@mia/shared-types"
import { clearEventStreamPrefs } from "../lib/event-stream-prefs"
import { firstTileIdForWidgetType } from "../lib/focus-widget-tile"
import { COLS } from "../lib/grid-math"
import {
    projectSpaceLayoutPreview,
    selectablePreviewLeaves,
} from "../lib/space-layout-preview"
import {
    mergeProductSpaces,
    migrateSpaceId,
    reapplyProductSpaceLayouts,
    resetSpaceView,
    SPACE_LAYOUT_VERSION,
    spaceById,
    spaceByIndex,
    type SpaceId,
} from "../lib/spaces"
import {
  collectLeafIds,
  projectTiles,
  removeLeaf,
  reparentLeaf,
  setSplitRatio,
  splitLargestLeaf,
  type DropZone,
  type SplitNode,
  type SplitPath,
} from "../lib/split-tree"
import { neighborTileForFocus, type FocusArrowKey } from "../lib/tile-focus-neighbor"
import { randomId } from "../lib/util"
import type { WidgetSizeDefaults } from "../lib/widget-layout-defaults"
import { WIDGET_DEFAULTS } from "../lib/widget-layout-defaults"
import {
    syncViewGeometry,
    type WorkspaceView,
} from "../lib/workspace-view"
import {
    canJoinZenSession,
    isZenViewId,
    newZenViewId,
    resolveZenKeepCap,
    resolveZenToggleInSession,
} from "../lib/zen-session"
import type { LayoutTile } from "../lib/grid-math"
import type { ViewConfig, WidgetType } from "../types"

/** Cleared on exit / view switch — never persisted. */
function emptyZenSession(): {
  zenActive: false
  zenSet: string[]
  zenExtraTiles: LayoutTile[]
  zenSplit: null
  zenReturnViewId: null
  zenTileId: null
} {
  return {
    zenActive: false,
    zenSet: [],
    zenExtraTiles: [],
    zenSplit: null,
    zenReturnViewId: null,
    zenTileId: null,
  }
}

function cloneSplit(node: SplitNode | null): SplitNode | null {
  if (!node) return null
  if (node.kind === "leaf") return { kind: "leaf", tileId: node.tileId }
  return {
    kind: "split",
    dir: node.dir,
    ratio: node.ratio,
    a: cloneSplit(node.a)!,
    b: cloneSplit(node.b)!,
  }
}

/** Remap leaf ids in a split tree (Save Zen Space → fresh tile ids). */
function remapSplit(
  node: SplitNode | null,
  idMap: ReadonlyMap<string, string>,
): SplitNode | null {
  if (!node) return null
  if (node.kind === "leaf") {
    const next = idMap.get(node.tileId)
    return next ? { kind: "leaf", tileId: next } : null
  }
  const a = remapSplit(node.a, idMap)
  const b = remapSplit(node.b, idMap)
  if (!a && !b) return null
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}

function leaveZenSession(s: {
  activeViewId: string
  zenReturnViewId: string | null
  zenSet: string[]
  soloTileId: string | null
  views: WorkspaceView[]
  focusedTileId: string | null
}): Partial<LayoutState> {
  const returnId =
    isZenViewId(s.activeViewId) && s.zenReturnViewId
      ? s.zenReturnViewId
      : null
  const returnView = returnId
    ? s.views.find((v) => v.id === returnId)
    : null
  return {
    ...emptyZenSession(),
    ...(returnView
      ? {
          activeViewId: returnView.id,
          focusedTileId: returnView.tiles[0]?.id ?? null,
          soloTileId: null,
        }
      : {
          // 1-tile Z/Esc exit leaves maximize; multi-tile clears solo.
          soloTileId: s.zenSet.length <= 1 ? s.soloTileId : null,
          focusedTileId: s.focusedTileId,
        }),
  }
}

export { WIDGET_DEFAULTS }

const DEFAULT_VIEW_ID = "default"

function focusedTileIdForPick(
  view: WorkspaceView,
  pickIndex: number,
): string | null {
  const leaves = selectablePreviewLeaves(
    projectSpaceLayoutPreview(view.split, view.tiles),
  )
  return leaves[pickIndex]?.tileId ?? null
}

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
   * Zen / focus: edge-to-edge immersion — hides workspace toolbar and widget
   * header. Session fields below are ephemeral (not persisted).
   */
  zenActive: boolean
  /** Tile ids in the immersion (1–2). Space-resident ids stay stable. */
  zenSet: string[]
  /** Companions not on the active Space — discarded on exit unless Save. */
  zenExtraTiles: LayoutTile[]
  /** Ephemeral split among zenSet — never mutates the underlying Space. */
  zenSplit: SplitNode | null
  /** View to restore when exiting a Call into a zen:* Space. */
  zenReturnViewId: string | null
  /**
   * Derived primary zen tile for chrome/legacy readers — focused member of
   * zenSet when active, else null.
   */
  zenTileId: string | null
  /** Latest measured viewport row budget for the active canvas. */
  viewportRows: number
  /** Tracks curated Space layout recipe; mismatch rebuilds product Spaces. */
  spaceLayoutVersion: number
  /**
   * Console role — from whoami. Default false until App sets it (operators
   * never briefly see admin Spaces). Not persisted.
   */
  consoleIsAdmin: boolean
  setConsoleIsAdmin: (isAdmin: boolean) => void

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
  /** Summon Keep while zen — companion / cap-swap into the session. */
  zenKeepWidget: (type: WidgetType) => void
  /** Snapshot current zen set as a zen:* view and activate it. */
  saveZenSpace: (name?: string) => string | null
  /** Activate a zen:* view and enter immersion for its tiles. */
  callZenSpace: (viewId: string) => void

  setFocusedTile: (tileId: string | null) => void
  clearEntering: (tileId: string) => void

  /** Seed product Spaces (Observe / Reconcile / Bridge / Agent) if missing. */
  ensureProductSpaces: () => void
  /** Activate a product Space by id or 1–5 index; focuses first tile. */
  callSpace: (space: SpaceId | number) => void
  /**
   * Call Space and focus the pickable leaf at `pickIndex` (blueprint order).
   * Falls back to the first tile when the index is out of range.
   */
  callSpaceFocusPick: (spaceId: SpaceId, pickIndex: number) => void
  /** Rebuild the active product Space to its curated default. */
  resetActiveSpace: () => void
  /**
   * Summon preset: land on a Space, rebuild curated widgets/ratios, focus
   * a primary tile — one atomic write (never navigate-only).
   * Optional `pickIndex` focuses a blueprint leaf after restore.
   */
  openSpacePreset: (
    spaceId: SpaceId,
    focusType: WidgetType,
    pickIndex?: number,
  ) => void
  /** Move keyboard focus to a geometric neighbor tile. */
  focusTileNeighbor: (key: FocusArrowKey) => void
  /** Ensure widget types exist on a view (add missing only). */
  ensureWidgets: (viewId: string, types: readonly WidgetType[]) => void
  /** Drop every tile of the given types from a view (Summon bag remove). */
  removeWidgetsByType: (viewId: string, types: readonly WidgetType[]) => void
  /** Activate any view (product Space or DIY) and focus first tile. */
  goView: (viewId: string) => void
  /** Activate any view and focus the blueprint leaf at pickIndex. */
  goViewFocusPick: (viewId: string, pickIndex: number) => void
  /**
   * Focus a widget type on the active view — clears solo/zen.
   * Does not maximize (operator uses M).
   */
  focusWidgetType: (type: WidgetType) => void
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      views: mergeProductSpaces([makeDefaultView()], 24, false),
      activeViewId: DEFAULT_VIEW_ID,
      focusedTileId: null,
      enteringTileIds: [],
      soloTileId: null,
      zenActive: false,
      zenSet: [],
      zenExtraTiles: [],
      zenSplit: null,
      zenReturnViewId: null,
      zenTileId: null,
      viewportRows: 24,
      spaceLayoutVersion: SPACE_LAYOUT_VERSION,
      consoleIsAdmin: false,

      setConsoleIsAdmin: (isAdmin) => set((s) => {
        if (s.consoleIsAdmin === isAdmin) return s
        const views = reapplyProductSpaceLayouts(
          mergeProductSpaces(s.views, s.viewportRows, isAdmin),
          s.viewportRows,
          isAdmin,
        )
        const activeOk = views.some((view) => view.id === s.activeViewId)
        return {
          consoleIsAdmin: isAdmin,
          views,
          activeViewId: activeOk ? s.activeViewId : (views[0]?.id ?? DEFAULT_VIEW_ID),
          soloTileId: null,
          ...emptyZenSession(),
          focusedTileId: null,
          spaceLayoutVersion: SPACE_LAYOUT_VERSION,
        }
      }),

      setActiveView: (id) => {
        if (isZenViewId(id)) {
          get().callZenSpace(id)
          return
        }
        set((s) => {
          const view = s.views.find((v) => v.id === id)
          return {
            activeViewId: id,
            soloTileId: null,
            ...emptyZenSession(),
            focusedTileId: view?.tiles[0]?.id ?? null,
          }
        })
      },

      addView: (name) => {
        const id = randomId()
        set((s) => ({
          views: [...s.views, { id, name, tiles: [], split: null }],
          activeViewId: id,
          soloTileId: null,
          ...emptyZenSession(),
        }))
        return id
      },

      removeView: (id) => set((s) => {
        const filtered = s.views.filter((view) => view.id !== id)
        if (filtered.length === 0) filtered.push(makeDefaultView())
        const removingActive = s.activeViewId === id
        const nextActive = removingActive
          ? filtered[0]!
          : filtered.find((v) => v.id === s.activeViewId) ?? filtered[0]!
        // Only tear down zen when the removed view was the active one —
        // deleting a saved Zen Space from Summon must not kill an unrelated session.
        if (!removingActive) {
          return { views: filtered }
        }
        return {
          views: filtered,
          activeViewId: nextActive.id,
          focusedTileId: nextActive.tiles[0]?.id ?? null,
          soloTileId: null,
          ...emptyZenSession(),
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
        if (!canOpenWidget(type, s.consoleIsAdmin)) return s
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
          ...emptyZenSession(),
        }
      }),

      removeWidget: (viewId, tileId) => {
        clearEventStreamPrefs(tileId)
        set((s) => {
          const nextSet = s.zenSet.filter((id) => id !== tileId)
          const zenCleared = s.zenActive && nextSet.length === 0
          return {
            views: s.views.map((view) => {
              if (view.id !== viewId) return view
              const tiles = view.tiles.filter((tile) => tile.id !== tileId)
              const split = removeLeaf(view.split, tileId)
              return withProjected({ ...view, tiles }, split, s.viewportRows)
            }),
            focusedTileId: s.focusedTileId === tileId ? null : s.focusedTileId,
            enteringTileIds: s.enteringTileIds.filter((id) => id !== tileId),
            soloTileId: s.soloTileId === tileId ? null : s.soloTileId,
            ...(zenCleared
              ? emptyZenSession()
              : {
                  zenSet: nextSet,
                  zenExtraTiles: s.zenExtraTiles.filter((t) => t.id !== tileId),
                  zenSplit: s.zenSplit
                    ? removeLeaf(s.zenSplit, tileId)
                    : s.zenSplit,
                  zenTileId:
                    s.zenTileId === tileId
                      ? (nextSet[0] ?? null)
                      : s.zenTileId,
                  zenActive: s.zenActive && nextSet.length > 0,
                  soloTileId:
                    s.zenActive && nextSet.length === 1
                      ? (nextSet[0] ?? null)
                      : s.soloTileId === tileId
                        ? null
                        : s.soloTileId,
                }),
          }
        })
      },

      commitSplit: (viewId, split) => set((s) => {
        if (s.soloTileId && !s.zenActive) return s
        if (s.zenActive) {
          // Immersion layout is session-local — never mutate the Space under it.
          if (isZenViewId(s.activeViewId)) {
            return {
              zenSplit: split,
              views: s.views.map((view) =>
                view.id === viewId
                  ? withProjected(view, split, s.viewportRows)
                  : view,
              ),
            }
          }
          return { zenSplit: split }
        }
        return {
          views: s.views.map((view) =>
            view.id === viewId ? withProjected(view, split, s.viewportRows) : view,
          ),
        }
      }),

      setSplitRatioAt: (viewId, path, ratio) => set((s) => {
        if (s.soloTileId && !s.zenActive) return s
        if (s.zenActive) {
          if (!s.zenSplit) return s
          const next = setSplitRatio(s.zenSplit, path, ratio)
          if (isZenViewId(s.activeViewId)) {
            return {
              zenSplit: next,
              views: s.views.map((view) =>
                view.id === viewId
                  ? withProjected(view, next, s.viewportRows)
                  : view,
              ),
            }
          }
          return { zenSplit: next }
        }
        return {
          views: s.views.map((view) => {
            if (view.id !== viewId || !view.split) return view
            return withProjected(view, setSplitRatio(view.split, path, ratio), s.viewportRows)
          }),
        }
      }),

      reparentTile: (viewId, dragId, targetId, zone) => set((s) => {
        if (s.soloTileId && !s.zenActive) return s
        if (s.zenActive) {
          if (!s.zenSplit) return s
          if (!s.zenSet.includes(dragId) || !s.zenSet.includes(targetId)) return s
          const next = reparentLeaf(s.zenSplit, dragId, targetId, zone)
          if (isZenViewId(s.activeViewId)) {
            return {
              zenSplit: next,
              views: s.views.map((view) =>
                view.id === viewId
                  ? withProjected(view, next, s.viewportRows)
                  : view,
              ),
            }
          }
          return { zenSplit: next }
        }
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
        if (restoring) {
          return {
            soloTileId: null,
            ...emptyZenSession(),
            focusedTileId: tileId,
          }
        }
        return {
          soloTileId: tileId,
          ...emptyZenSession(),
          focusedTileId: tileId,
        }
      }),

      toggleTileZen: (_viewId, tileId) => set((s) => {
        if (s.zenActive && s.zenSet.includes(tileId)) {
          const action = resolveZenToggleInSession(s.zenSet, tileId)
          if (action.type === "exit") {
            return leaveZenSession({ ...s, focusedTileId: tileId })
          }
          const nextFocus = action.nextSet[0]!
          return {
            zenActive: true,
            zenSet: action.nextSet,
            zenExtraTiles: s.zenExtraTiles.filter((t) =>
              action.nextSet.includes(t.id),
            ),
            zenSplit: s.zenSplit
              ? removeLeaf(s.zenSplit, tileId)
              : { kind: "leaf", tileId: nextFocus },
            zenTileId: nextFocus,
            soloTileId: nextFocus,
            focusedTileId: nextFocus,
          }
        }
        return {
          zenActive: true,
          zenSet: [tileId],
          zenExtraTiles: [],
          zenSplit: { kind: "leaf", tileId },
          zenReturnViewId: isZenViewId(s.activeViewId)
            ? s.zenReturnViewId
            : s.activeViewId,
          zenTileId: tileId,
          soloTileId: tileId,
          focusedTileId: tileId,
        }
      }),

      exitTileZen: () => set((s) => leaveZenSession(s)),

      zenKeepWidget: (type) => set((s) => {
        if (!s.zenActive || !canJoinZenSession(type)) return s
        const view = s.views.find((v) => v.id === s.activeViewId)
        if (!view) return s

        const typesById = new Map<string, WidgetType>()
        for (const tile of view.tiles) typesById.set(tile.id, tile.type)
        for (const tile of s.zenExtraTiles) typesById.set(tile.id, tile.type)

        for (const id of s.zenSet) {
          if (typesById.get(id) === type) {
            return { focusedTileId: id, zenTileId: id }
          }
        }

        const onSpace = view.tiles.find((t) => t.type === type)
        const newId = onSpace?.id ?? randomId()
        const { nextSet, replaceId } = resolveZenKeepCap(
          s.zenSet,
          typesById,
          s.focusedTileId,
          type,
          newId,
        )

        let zenExtraTiles = s.zenExtraTiles
        if (!onSpace) {
          const defaults = WIDGET_DEFAULTS[type] as WidgetSizeDefaults
          const extra: LayoutTile = {
            id: newId,
            type,
            x: 0,
            y: 0,
            w: defaults.w,
            h: defaults.h,
            minW: defaults.minW,
            minH: defaults.minH,
          }
          zenExtraTiles = [
            ...s.zenExtraTiles.filter((t) => t.id !== replaceId),
            extra,
          ]
        } else if (replaceId) {
          zenExtraTiles = s.zenExtraTiles.filter((t) => t.id !== replaceId)
        }

        let zenSplit: SplitNode =
          s.zenSplit ?? { kind: "leaf", tileId: s.zenSet[0]! }
        if (replaceId) {
          zenSplit = removeLeaf(zenSplit, replaceId)
            ?? { kind: "leaf", tileId: newId }
          zenSplit = splitLargestLeaf(zenSplit, newId, COLS, s.viewportRows)
        } else {
          zenSplit = splitLargestLeaf(zenSplit, newId, COLS, s.viewportRows)
        }

        return {
          zenActive: true,
          zenSet: nextSet,
          zenExtraTiles,
          zenSplit,
          zenTileId: newId,
          soloTileId: nextSet.length === 1 ? newId : null,
          focusedTileId: newId,
        }
      }),

      saveZenSpace: (name) => {
        const s = get()
        if (!s.zenActive || s.zenSet.length === 0) return null
        const view = s.views.find((v) => v.id === s.activeViewId)
        if (!view) return null

        const idByTile = new Map<string, LayoutTile>()
        for (const tile of view.tiles) idByTile.set(tile.id, tile)
        for (const tile of s.zenExtraTiles) idByTile.set(tile.id, tile)

        // Update path: persist quietly — keep tile ids so React instances stay mounted.
        if (isZenViewId(s.activeViewId)) {
          const tiles: LayoutTile[] = []
          for (const id of s.zenSet) {
            const src = idByTile.get(id)
            if (!src || !canJoinZenSession(src.type)) continue
            tiles.push({ ...src })
          }
          if (tiles.length === 0) return null
          const split =
            cloneSplit(s.zenSplit) ??
            (tiles[1]
              ? {
                  kind: "split" as const,
                  dir: "v" as const,
                  ratio: 0.5,
                  a: { kind: "leaf" as const, tileId: tiles[0]!.id },
                  b: { kind: "leaf" as const, tileId: tiles[1]!.id },
                }
              : { kind: "leaf" as const, tileId: tiles[0]!.id })
          const defaultName = `Zen ${tiles.map((t) => t.type).join(" · ")}`
          const zenView = withProjected(
            {
              id: s.activeViewId,
              name: name?.trim() || view.name || defaultName,
              tiles,
              split: null,
            },
            split,
            s.viewportRows,
          )
          set({
            views: s.views.map((v) => (v.id === zenView.id ? zenView : v)),
            // Fold session extras into the view; leave focus / zenSet alone.
            zenExtraTiles: [],
            zenSplit: cloneSplit(zenView.split),
          })
          return zenView.id
        }

        // First Save from a product Space / DIY — snapshot into a new zen:* view.
        const idMap = new Map<string, string>()
        const tiles: LayoutTile[] = []
        for (const id of s.zenSet) {
          const src = idByTile.get(id)
          if (!src || !canJoinZenSession(src.type)) continue
          const nextId = randomId()
          idMap.set(id, nextId)
          tiles.push({
            ...src,
            id: nextId,
            x: 0,
            y: 0,
          })
        }
        if (tiles.length === 0) return null

        const zenId = newZenViewId()
        const split =
          remapSplit(s.zenSplit, idMap) ??
          (tiles[1]
            ? {
                kind: "split" as const,
                dir: "v" as const,
                ratio: 0.5,
                a: { kind: "leaf" as const, tileId: tiles[0]!.id },
                b: { kind: "leaf" as const, tileId: tiles[1]!.id },
              }
            : { kind: "leaf" as const, tileId: tiles[0]!.id })
        const defaultName = `Zen ${tiles.map((t) => t.type).join(" · ")}`
        const zenView = withProjected(
          {
            id: zenId,
            name: name?.trim() || defaultName,
            tiles,
            split: null,
          },
          split,
          s.viewportRows,
        )
        const focusId = zenView.tiles[0]?.id ?? null
        set({
          views: [...s.views, zenView],
          activeViewId: zenId,
          zenActive: true,
          zenSet: zenView.tiles.map((t) => t.id),
          zenExtraTiles: [],
          zenSplit: cloneSplit(zenView.split),
          zenReturnViewId: s.activeViewId,
          zenTileId: focusId,
          soloTileId: zenView.tiles.length === 1 ? focusId : null,
          focusedTileId: focusId,
        })
        return zenId
      },

      callZenSpace: (viewId) => {
        if (!isZenViewId(viewId)) return
        set((s) => {
          const view = s.views.find((v) => v.id === viewId)
          if (!view || view.tiles.length === 0) return s
          const setIds = view.tiles
            .filter((t) => canJoinZenSession(t.type))
            .map((t) => t.id)
            .slice(0, 2)
          if (setIds.length === 0) return s
          const focusId = setIds[0]!
          const returnId = isZenViewId(s.activeViewId)
            ? s.zenReturnViewId
            : s.activeViewId
          // Prefer the saved view split when it covers the set; else rebuild.
          const leafIds = new Set(collectLeafIds(view.split))
          const splitCovers = setIds.every((id) => leafIds.has(id))
          const zenSplit = splitCovers
            ? cloneSplit(view.split)
            : setIds.length === 1
              ? { kind: "leaf" as const, tileId: setIds[0]! }
              : {
                  kind: "split" as const,
                  dir: "v" as const,
                  ratio: 0.5,
                  a: { kind: "leaf" as const, tileId: setIds[0]! },
                  b: { kind: "leaf" as const, tileId: setIds[1]! },
                }
          return {
            activeViewId: viewId,
            zenActive: true,
            zenSet: setIds,
            zenExtraTiles: [],
            zenSplit,
            zenReturnViewId: returnId,
            zenTileId: focusId,
            soloTileId: setIds.length === 1 ? focusId : null,
            focusedTileId: focusId,
          }
        })
      },

      setFocusedTile: (tileId) => set((s) => {
        if (
          s.zenActive &&
          tileId &&
          s.zenSet.length > 0 &&
          !s.zenSet.includes(tileId)
        ) {
          return s
        }
        return {
          focusedTileId: tileId,
          zenTileId:
            s.zenActive && tileId && s.zenSet.includes(tileId)
              ? tileId
              : s.zenActive
                ? s.zenTileId
                : null,
        }
      }),

      clearEntering: (tileId) => set((s) => ({
        enteringTileIds: s.enteringTileIds.filter((id) => id !== tileId),
      })),

      ensureProductSpaces: () => set((s) => ({
        views: mergeProductSpaces(s.views, s.viewportRows, s.consoleIsAdmin),
      })),

      callSpace: (space) => {
        set((s) => {
          const def =
            typeof space === "number"
              ? spaceByIndex(space, s.consoleIsAdmin)
              : spaceById(space, s.consoleIsAdmin)
          if (!def) return s
          const views = mergeProductSpaces(s.views, s.viewportRows, s.consoleIsAdmin)
          const view = views.find((v) => v.id === def.id)
          return {
            views,
            activeViewId: def.id,
            soloTileId: null,
            ...emptyZenSession(),
            focusedTileId: view?.tiles[0]?.id ?? null,
          }
        })
      },

      callSpaceFocusPick: (spaceId, pickIndex) => {
        set((s) => {
          const def = spaceById(spaceId, s.consoleIsAdmin)
          if (!def) return s
          const views = mergeProductSpaces(s.views, s.viewportRows, s.consoleIsAdmin)
          const view = views.find((v) => v.id === def.id)
          const focusedTileId = view
            ? focusedTileIdForPick(view, pickIndex)
            : null
          return {
            views,
            activeViewId: def.id,
            soloTileId: null,
            ...emptyZenSession(),
            focusedTileId: focusedTileId ?? view?.tiles[0]?.id ?? null,
          }
        })
      },

      resetActiveSpace: () => {
        const s = get()
        const def = spaceById(s.activeViewId, s.consoleIsAdmin)
        const focusType = def?.widgets[0]
        if (!def || !focusType) return
        get().openSpacePreset(def.id, focusType)
      },

      openSpacePreset: (spaceId, focusType, pickIndex) => {
        set((s) => {
          const def = spaceById(spaceId, s.consoleIsAdmin)
          if (!def) return s
          if (!canOpenWidget(focusType, s.consoleIsAdmin)) return s
          const views = resetSpaceView(
            mergeProductSpaces(s.views, s.viewportRows, s.consoleIsAdmin),
            def.id,
            s.viewportRows,
            s.consoleIsAdmin,
          )
          const view = views.find((v) => v.id === def.id)
          const fromPick =
            view && pickIndex != null
              ? focusedTileIdForPick(view, pickIndex)
              : null
          const focusedTileId =
            fromPick
            ?? (view ? firstTileIdForWidgetType(view.tiles, focusType) : null)
            ?? view?.tiles[0]?.id
            ?? null
          return {
            views,
            activeViewId: def.id,
            soloTileId: null,
            ...emptyZenSession(),
            focusedTileId,
          }
        })
      },

      focusTileNeighbor: (key) => set((s) => {
        const view = s.views.find((v) => v.id === s.activeViewId)
        if (!view) return s

        if (s.zenActive && s.zenSet.length > 0) {
          const byId = new Map<string, LayoutTile>()
          for (const tile of view.tiles) byId.set(tile.id, tile)
          for (const tile of s.zenExtraTiles) byId.set(tile.id, tile)
          const focusTiles = s.zenSet
            .map((id) => byId.get(id))
            .filter((t): t is LayoutTile => !!t)
          if (focusTiles.length === 0) return s
          if (!s.focusedTileId || !s.zenSet.includes(s.focusedTileId)) {
            const id = focusTiles[0]!.id
            return { focusedTileId: id, zenTileId: id }
          }
          // Cap-2: project the ephemeral zen split so arrows follow panes.
          const projected = s.zenSplit
            ? projectTiles(s.zenSplit, focusTiles, COLS, s.viewportRows)
            : focusTiles
          const nextId = neighborTileForFocus(projected, s.focusedTileId, key)
          if (!nextId) return s
          return { focusedTileId: nextId, zenTileId: nextId }
        }

        if (view.tiles.length === 0) return s
        // No focus yet — take the first tile, then the next chord moves.
        if (!s.focusedTileId) {
          return { focusedTileId: view.tiles[0]!.id }
        }
        const nextId = neighborTileForFocus(view.tiles, s.focusedTileId, key)
        if (!nextId) return s
        return { focusedTileId: nextId }
      }),

      /** One atomic write — Summon multi-keep must not land a partial bag. */
      ensureWidgets: (viewId, types) => set((s) => {
        const view = s.views.find((v) => v.id === viewId)
        if (!view) return s
        let tiles = view.tiles
        let split = view.split
        const entering = [...s.enteringTileIds]
        let changed = false
        for (const type of types) {
          if (!canOpenWidget(type, s.consoleIsAdmin)) continue
          if (tiles.some((tile) => tile.type === type)) continue
          const defaults = WIDGET_DEFAULTS[type] as WidgetSizeDefaults | undefined
          if (!defaults) continue
          const id = randomId()
          tiles = [
            ...tiles,
            {
              id,
              type,
              x: 0,
              y: 0,
              w: defaults.w,
              h: defaults.h,
              minW: defaults.minW,
              minH: defaults.minH,
            },
          ]
          split = splitLargestLeaf(split, id, COLS, s.viewportRows)
          entering.push(id)
          changed = true
        }
        if (!changed) {
          return { soloTileId: null, ...emptyZenSession() }
        }
        return {
          views: s.views.map((v) =>
            v.id === viewId ? withProjected({ ...v, tiles }, split, s.viewportRows) : v,
          ),
          enteringTileIds: entering,
          soloTileId: null,
          ...emptyZenSession(),
        }
      }),

      removeWidgetsByType: (viewId, types) => {
        if (types.length === 0) return
        const drop = new Set(types)
        set((s) => {
          const view = s.views.find((v) => v.id === viewId)
          if (!view) return s
          const removedIds = new Set(
            view.tiles.filter((tile) => drop.has(tile.type)).map((tile) => tile.id),
          )
          if (removedIds.size === 0) return s
          for (const tileId of removedIds) clearEventStreamPrefs(tileId)
          let split = view.split
          for (const tileId of removedIds) {
            split = removeLeaf(split, tileId)
          }
          const tiles = view.tiles.filter((tile) => !removedIds.has(tile.id))
          const focusedGone =
            s.focusedTileId != null && removedIds.has(s.focusedTileId)
          const nextZenSet = s.zenSet.filter((id) => !removedIds.has(id))
          const zenCleared = s.zenActive && nextZenSet.length === 0
          return {
            views: s.views.map((v) =>
              v.id === viewId
                ? withProjected({ ...v, tiles }, split, s.viewportRows)
                : v,
            ),
            focusedTileId: focusedGone
              ? (tiles[0]?.id ?? null)
              : s.focusedTileId,
            enteringTileIds: s.enteringTileIds.filter((id) => !removedIds.has(id)),
            soloTileId:
              s.soloTileId && removedIds.has(s.soloTileId) ? null : s.soloTileId,
            ...(zenCleared
              ? emptyZenSession()
              : {
                  zenSet: nextZenSet,
                  zenExtraTiles: s.zenExtraTiles.filter(
                    (t) => !removedIds.has(t.id),
                  ),
                  zenSplit: (() => {
                    let split = s.zenSplit
                    for (const id of removedIds) {
                      if (split) split = removeLeaf(split, id)
                    }
                    return split
                  })(),
                  zenTileId:
                    s.zenTileId && removedIds.has(s.zenTileId)
                      ? (nextZenSet[0] ?? null)
                      : s.zenTileId,
                  zenActive: s.zenActive && nextZenSet.length > 0,
                }),
          }
        })
      },

      goView: (viewId) => {
        if (isZenViewId(viewId)) {
          get().callZenSpace(viewId)
          return
        }
        set((s) => {
          const view = s.views.find((v) => v.id === viewId)
          if (!view) return s
          return {
            activeViewId: viewId,
            soloTileId: null,
            ...emptyZenSession(),
            focusedTileId: view.tiles[0]?.id ?? null,
          }
        })
      },

      goViewFocusPick: (viewId, pickIndex) => set((s) => {
        const view = s.views.find((v) => v.id === viewId)
        if (!view) return s
        const focusedTileId =
          focusedTileIdForPick(view, pickIndex) ?? view.tiles[0]?.id ?? null
        return {
          activeViewId: viewId,
          soloTileId: null,
          ...emptyZenSession(),
          focusedTileId,
        }
      }),

      focusWidgetType: (type) => set((s) => {
        if (s.zenActive) {
          const typesById = new Map<string, WidgetType>()
          const view = s.views.find((v) => v.id === s.activeViewId)
          for (const tile of view?.tiles ?? []) typesById.set(tile.id, tile.type)
          for (const tile of s.zenExtraTiles) typesById.set(tile.id, tile.type)
          const inZen = s.zenSet.find((id) => typesById.get(id) === type)
          if (inZen) {
            return { focusedTileId: inZen, zenTileId: inZen }
          }
          return s
        }
        const view = s.views.find((v) => v.id === s.activeViewId)
        if (!view) return s
        const tileId = firstTileIdForWidgetType(view.tiles, type)
        if (!tileId) return s
        return {
          focusedTileId: tileId,
          soloTileId: null,
          ...emptyZenSession(),
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
        // Role unknown at hydrate — operator-safe merge; App setConsoleIsAdmin upgrades.
        const isAdmin = false
        const version = persisted.spaceLayoutVersion ?? 0
        const views =
          version === SPACE_LAYOUT_VERSION
            ? mergeProductSpaces(rawViews, currentState.viewportRows, isAdmin)
            : reapplyProductSpaceLayouts(
                mergeProductSpaces(rawViews, currentState.viewportRows, isAdmin),
                currentState.viewportRows,
                isAdmin,
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
          ...emptyZenSession(),
          viewportRows: currentState.viewportRows,
          spaceLayoutVersion: SPACE_LAYOUT_VERSION,
          consoleIsAdmin: false,
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
