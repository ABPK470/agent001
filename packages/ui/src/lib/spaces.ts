/**
 * Product Spaces — curated job landings with fixed default autolayouts.
 * Named DIY views remain secondary; Spaces are the commercial landing.
 *
 * Defaults (ratios of the canvas):
 * - Observe: Pipelines 70% | Event stream 30%
 * - Debug: Threads 20% | Trace 80%
 * - Reconcile: Sync 50% | Entity registry 50%
 * - Agent: Trace 60% | (Chat / Threads 50/50 in the remaining 40%)
 * - Bridge: Bridge alone
 */

import type { WidgetType } from "../types"
import { COLS } from "./grid-math"
import { leafNode, type SplitNode } from "./split-tree"
import { WIDGET_DEFAULTS } from "./widget-layout-defaults"
import type { WorkspaceView } from "./workspace-view"
import { syncViewGeometry } from "./workspace-view"
import { randomId } from "./util"

export type SpaceId =
  | "space:agent"
  | "space:observe"
  | "space:reconcile"
  | "space:bridge"
  | "space:debug"

export type ProductBundleId = "bundle:agent-debug" | "bundle:observe-core" | "bundle:reconcile-core"

/**
 * Bump when curated Space widgets/ratios change so persisted product Spaces
 * rebuild to the new defaults (DIY-named views are left alone).
 */
export const SPACE_LAYOUT_VERSION = 4

export interface ProductSpaceDef {
  id: SpaceId
  /**
   * 1–4 = Call Space (⌘/Ctrl+1…4).
   * 0 = Summon / bundle only (no Call Space chord).
   */
  index: number
  name: string
  desc: string
  widgets: readonly WidgetType[]
}

export interface ProductBundleDef {
  id: ProductBundleId
  name: string
  desc: string
  /** Space to land in when the bundle is opened. */
  homeSpace: SpaceId
  /** Tile to focus after open (never auto-maximize). */
  focusType: WidgetType
  /** Widgets ensured on the home Space. */
  widgets: readonly WidgetType[]
}

export const PRODUCT_SPACES: readonly ProductSpaceDef[] = [
  {
    id: "space:agent",
    index: 1,
    name: "Agent",
    desc: "Trace with chat and threads",
    widgets: ["debug-inspector", "term-chat", "thread-nav"],
  },
  {
    id: "space:observe",
    index: 2,
    name: "Observe",
    desc: "Pipelines and event stream",
    widgets: ["operation-log", "live-logs"],
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
  {
    id: "space:debug",
    index: 0,
    name: "Debug",
    desc: "Threads beside Trace",
    widgets: ["thread-nav", "debug-inspector"],
  },
]

export const PRODUCT_BUNDLES: readonly ProductBundleDef[] = [
  {
    id: "bundle:agent-debug",
    name: "Agent debug",
    desc: "Debug Space — Threads 20% · Trace 80%",
    homeSpace: "space:debug",
    focusType: "debug-inspector",
    widgets: ["thread-nav", "debug-inspector"],
  },
  {
    id: "bundle:observe-core",
    name: "Observe core",
    desc: "Observe Space — Pipelines 70% · Event stream 30%",
    homeSpace: "space:observe",
    focusType: "operation-log",
    widgets: ["operation-log", "live-logs"],
  },
  {
    id: "bundle:reconcile-core",
    name: "Reconcile core",
    desc: "Reconcile Space — Sync · Entity registry 50/50",
    homeSpace: "space:reconcile",
    focusType: "env-sync",
    widgets: ["env-sync", "entity-registry"],
  },
]

export function spaceById(id: string): ProductSpaceDef | undefined {
  return PRODUCT_SPACES.find((space) => space.id === id)
}

export function spaceByIndex(index: number): ProductSpaceDef | undefined {
  if (index < 1) return undefined
  return PRODUCT_SPACES.find((space) => space.index === index)
}

export function bundleById(id: string): ProductBundleDef | undefined {
  return PRODUCT_BUNDLES.find((bundle) => bundle.id === id)
}

export function isProductSpaceId(id: string): id is SpaceId {
  return PRODUCT_SPACES.some((space) => space.id === id)
}

function vSplit(ratio: number, a: SplitNode, b: SplitNode): SplitNode {
  return { kind: "split", dir: "v", ratio, a, b }
}

function hSplit(ratio: number, a: SplitNode, b: SplitNode): SplitNode {
  return { kind: "split", dir: "h", ratio, a, b }
}

function makeTile(type: WidgetType): WorkspaceView["tiles"][number] {
  const defaults = WIDGET_DEFAULTS[type]
  return {
    id: randomId(),
    type,
    x: 0,
    y: 0,
    w: defaults.w,
    h: defaults.h,
    minW: defaults.minW,
    minH: defaults.minH,
  }
}

/**
 * Curated split tree per Space. Tile order matches `def.widgets`
 * (first tile = Call Space focus target).
 */
function buildSpaceSplit(
  spaceId: SpaceId,
  byType: ReadonlyMap<WidgetType, string>,
): SplitNode | null {
  const id = (type: WidgetType) => {
    const tileId = byType.get(type)
    if (!tileId) throw new Error(`spaces: missing tile for ${type} in ${spaceId}`)
    return leafNode(tileId)
  }

  if (spaceId === "space:observe") {
    // Pipelines 70% | Event stream 30%
    return vSplit(0.7, id("operation-log"), id("live-logs"))
  }
  if (spaceId === "space:debug") {
    // Threads 20% | Trace 80%
    return vSplit(0.2, id("thread-nav"), id("debug-inspector"))
  }
  if (spaceId === "space:reconcile") {
    // Sync 50% | Entity registry 50%
    return vSplit(0.5, id("env-sync"), id("entity-registry"))
  }
  if (spaceId === "space:agent") {
    // Trace 60% | (Chat / Threads 50/50 in remaining 40%)
    return vSplit(
      0.6,
      id("debug-inspector"),
      hSplit(0.5, id("term-chat"), id("thread-nav")),
    )
  }
  if (spaceId === "space:bridge") {
    return id("bridge")
  }
  return null
}

/** Build a fresh Space view with curated widgets + ratios (stable Space id). */
export function buildSpaceView(def: ProductSpaceDef, rows = 24): WorkspaceView {
  const tiles = def.widgets.map((type) => makeTile(type))
  const byType = new Map(tiles.map((tile) => [tile.type, tile.id] as const))
  const split = buildSpaceSplit(def.id, byType)
  return syncViewGeometry(
    {
      id: def.id,
      name: def.name,
      tiles,
      split,
    },
    rows,
    COLS,
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

/**
 * Rebuild all product Spaces to the current curated defaults.
 * DIY-named views are preserved.
 */
export function reapplyProductSpaceLayouts(
  views: readonly WorkspaceView[],
  rows = 24,
): WorkspaceView[] {
  const productIds = new Set(PRODUCT_SPACES.map((space) => space.id))
  const kept = views.filter((view) => !productIds.has(view.id as SpaceId))
  const rebuilt = PRODUCT_SPACES.map((def) => buildSpaceView(def, rows))
  return [...kept, ...rebuilt]
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
