/**
 * Product Spaces — jobs-to-be-done layouts (Observe, Reconcile, Bridge, Agent).
 * Named DIY views remain secondary; Spaces are the commercial landing.
 */

import type { WidgetType } from "../types"
import { COLS } from "./grid-math"
import { splitLargestLeaf, type SplitNode } from "./split-tree"
import { WIDGET_DEFAULTS } from "./widget-layout-defaults"
import type { WorkspaceView } from "./workspace-view"
import { syncViewGeometry } from "./workspace-view"
import { randomId } from "./util"

export type SpaceId = "space:agent" | "space:observe" | "space:reconcile" | "space:bridge"

export type ProductBundleId = "bundle:agent-debug" | "bundle:observe-core" | "bundle:reconcile-core"

export interface ProductSpaceDef {
  id: SpaceId
  /** 1-based Call Space index (Ctrl/Cmd+1…4). */
  index: number
  name: string
  desc: string
  widgets: readonly WidgetType[]
}

export interface ProductBundleDef {
  id: ProductBundleId
  name: string
  desc: string
  /** Widgets opened together; first is the Summon peek target. */
  widgets: readonly WidgetType[]
}

export const PRODUCT_SPACES: readonly ProductSpaceDef[] = [
  {
    id: "space:agent",
    index: 1,
    name: "Agent",
    desc: "Direct goals — threads, chat, trace, run status",
    widgets: ["thread-nav", "term-chat", "debug-inspector", "run-status"],
  },
  {
    id: "space:observe",
    index: 2,
    name: "Observe",
    desc: "Platform ops — pipelines, event stream, threads, trace",
    widgets: ["operation-log", "live-logs", "thread-nav", "debug-inspector"],
  },
  {
    id: "space:reconcile",
    index: 3,
    name: "Reconcile",
    desc: "Sync and entity configuration",
    widgets: ["env-sync", "entity-registry"],
  },
  {
    id: "space:bridge",
    index: 4,
    name: "Bridge",
    desc: "Bridge operations",
    widgets: ["bridge"],
  },
]

export const PRODUCT_BUNDLES: readonly ProductBundleDef[] = [
  {
    id: "bundle:agent-debug",
    name: "Agent debug",
    desc: "Threads + Trace — run selection with inspector",
    widgets: ["thread-nav", "debug-inspector"],
  },
  {
    id: "bundle:observe-core",
    name: "Observe core",
    desc: "Pipelines + Event stream",
    widgets: ["operation-log", "live-logs"],
  },
  {
    id: "bundle:reconcile-core",
    name: "Reconcile core",
    desc: "Sync + Entity registry",
    widgets: ["env-sync", "entity-registry"],
  },
]

export function spaceById(id: string): ProductSpaceDef | undefined {
  return PRODUCT_SPACES.find((space) => space.id === id)
}

export function spaceByIndex(index: number): ProductSpaceDef | undefined {
  return PRODUCT_SPACES.find((space) => space.index === index)
}

export function bundleById(id: string): ProductBundleDef | undefined {
  return PRODUCT_BUNDLES.find((bundle) => bundle.id === id)
}

export function isProductSpaceId(id: string): id is SpaceId {
  return PRODUCT_SPACES.some((space) => space.id === id)
}

/** Build a fresh Space view with curated widgets (stable Space id). */
export function buildSpaceView(def: ProductSpaceDef, rows = 24): WorkspaceView {
  let split: SplitNode | null = null
  const tiles = def.widgets.map((type) => {
    const defaults = WIDGET_DEFAULTS[type]
    const id = randomId()
    split = splitLargestLeaf(split, id, COLS, rows)
    return {
      id,
      type,
      x: 0,
      y: 0,
      w: defaults.w,
      h: defaults.h,
      minW: defaults.minW,
      minH: defaults.minH,
    }
  })
  return syncViewGeometry(
    {
      id: def.id,
      name: def.name,
      tiles,
      split,
    },
    rows,
  )
}

/** Ensure every product Space exists; never wipe unrelated user views. */
export function mergeProductSpaces(
  views: readonly WorkspaceView[],
  rows = 24,
): WorkspaceView[] {
  const byId = new Map(views.map((view) => [view.id, view]))
  const next = [...views]
  for (const def of PRODUCT_SPACES) {
    if (byId.has(def.id)) continue
    const built = buildSpaceView(def, rows)
    next.push(built)
    byId.set(def.id, built)
  }
  return next
}

/** Replace a Space’s tiles/split with the product default. */
export function resetSpaceView(
  views: readonly WorkspaceView[],
  spaceId: SpaceId,
  rows = 24,
): WorkspaceView[] {
  const def = spaceById(spaceId)
  if (!def) return [...views]
  const built = buildSpaceView(def, rows)
  const has = views.some((view) => view.id === spaceId)
  if (!has) return [...views, built]
  return views.map((view) => (view.id === spaceId ? built : view))
}

export function primarySpaceForWidget(type: WidgetType): SpaceId | null {
  for (const space of PRODUCT_SPACES) {
    if (space.widgets.includes(type)) return space.id
  }
  return null
}
