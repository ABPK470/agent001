/**
 * Summon right-pane model — pure.
 * Space/preset → blueprint; surface → card; empty → idle.
 */

import {
  dedicatedSpaceForWidget,
  buildSpaceView,
  spaceById,
  type SpaceId,
} from "../../lib/spaces"
import {
  projectSpaceLayoutPreview,
  selectablePreviewLeaves,
} from "../../lib/space-layout-preview"
import type { SplitNode } from "../../lib/split-tree"
import type { WorkspaceView } from "../../lib/workspace-view"
import type { WidgetType } from "../../types"
import type { SummonItem } from "./summon-items"

export type SummonPreviewPickable = {
  tileId: string
  type: WidgetType
  index: number
}

export type SummonPreviewModel =
  | {
      mode: "blueprint"
      name: string
      meta: string
      split: SplitNode | null
      tiles: readonly { id: string; type: WidgetType }[]
      pickable: readonly SummonPreviewPickable[]
    }
  | {
      mode: "surface"
      type: WidgetType
      name: string
      desc: string
      onActiveSpace: boolean
      dedicatedSpace: SpaceId | null
      /** Surfaces staged in the keep bag (0 = single-item mode). */
      pickedCount: number
    }
  | { mode: "idle"; prompt: string }

function viewForSpace(
  viewId: string,
  views: readonly WorkspaceView[],
  rows: number,
  isAdmin: boolean,
): WorkspaceView {
  const live = views.find((view) => view.id === viewId)
  if (live) return live
  const def = spaceById(viewId, isAdmin)
  if (!def) {
    return { id: viewId, name: viewId, tiles: [], split: null }
  }
  return buildSpaceView(def, rows)
}

function blueprintFromView(
  view: WorkspaceView,
  meta: string,
): Extract<SummonPreviewModel, { mode: "blueprint" }> {
  const leaves = projectSpaceLayoutPreview(view.split, view.tiles)
  const pickable = selectablePreviewLeaves(leaves).map((leaf, index) => ({
    tileId: leaf.tileId,
    type: leaf.type!,
    index,
  }))
  return {
    mode: "blueprint",
    name: view.name,
    meta,
    split: view.split,
    tiles: view.tiles.map((tile) => ({ id: tile.id, type: tile.type })),
    pickable,
  }
}

export function resolveSummonPreview(
  item: SummonItem | null,
  views: readonly WorkspaceView[],
  opts: {
    presentTypes: ReadonlySet<string>
    viewportRows?: number
    pickedCount?: number
    isAdmin?: boolean
  },
): SummonPreviewModel {
  const rows = opts.viewportRows ?? 24
  const pickedCount = opts.pickedCount ?? 0
  const isAdmin = opts.isAdmin ?? false
  if (!item) {
    return {
      mode: "idle",
      prompt:
        pickedCount > 0
          ? `Enter keeps ${pickedCount} surfaces`
          : "Pick a Space, preset, or surface",
    }
  }
  if (item.kind === "space") {
    const view = viewForSpace(item.id, views, rows, isAdmin)
    return blueprintFromView(view, item.desc)
  }
  if (item.kind === "bundle") {
    const view = viewForSpace(item.homeSpace, views, rows, isAdmin)
    return blueprintFromView(view, item.desc)
  }
  return {
    mode: "surface",
    type: item.type,
    name: item.name,
    desc: item.desc,
    onActiveSpace: opts.presentTypes.has(item.type),
    dedicatedSpace: dedicatedSpaceForWidget(item.type, isAdmin),
    pickedCount,
  }
}

/** Hotkey caption for blueprint tiles (1 or 1–n). */
export function summonPreviewHotkeyHint(tileCount: number): string {
  if (tileCount <= 1) return "1"
  if (tileCount <= 9) return `1–${tileCount}`
  return "1–9"
}
