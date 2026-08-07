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
    }
  | { mode: "idle"; prompt: string }

function viewForSpace(
  spaceId: SpaceId,
  views: readonly WorkspaceView[],
  rows: number,
): WorkspaceView {
  const live = views.find((view) => view.id === spaceId)
  if (live) return live
  const def = spaceById(spaceId)
  if (!def) {
    return { id: spaceId, name: spaceId, tiles: [], split: null }
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
  },
): SummonPreviewModel {
  const rows = opts.viewportRows ?? 24
  if (!item) {
    return { mode: "idle", prompt: "Pick a Space, preset, or surface" }
  }
  if (item.kind === "space") {
    const view = viewForSpace(item.id, views, rows)
    return blueprintFromView(view, item.desc)
  }
  if (item.kind === "bundle") {
    const view = viewForSpace(item.homeSpace, views, rows)
    return blueprintFromView(view, item.desc)
  }
  return {
    mode: "surface",
    type: item.type,
    name: item.name,
    desc: item.desc,
    onActiveSpace: opts.presentTypes.has(item.type),
    dedicatedSpace: dedicatedSpaceForWidget(item.type),
  }
}

/** Hotkey caption for blueprint tiles (1 or 1–n). */
export function summonPreviewHotkeyHint(tileCount: number): string {
  if (tileCount <= 1) return "1"
  if (tileCount <= 9) return `1–${tileCount}`
  return "1–9"
}
