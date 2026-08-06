/**
 * Product Spaces — curated job landings with fixed default autolayouts.
 * Named DIY views remain secondary; Spaces are the commercial landing.
 *
 * Defaults (ratios of the canvas):
 * - Observe: Pipelines 70% | Event stream 30%
 * - Trace: Trace alone (self-sufficient scope bar + drawer)
 * - Reconcile: Sync 50% | Entity registry 50%
 * - Agent: Trace 60% | (Chat / Threads 50/50 in the remaining 40%)
 * - Bridge: Bridge alone
 */

import type { WidgetType } from "../types"
import { COLS } from "./grid-math"
import { leafNode, type SplitDir, type SplitNode } from "./split-tree"
import { WIDGET_DEFAULTS } from "./widget-layout-defaults"
import type { WorkspaceView } from "./workspace-view"
import { syncViewGeometry } from "./workspace-view"
import { randomId } from "./util"

/** Split shape keyed by widget type — tile ids are ephemeral. */
type SpaceSplitShape =
  | { kind: "leaf"; type: WidgetType }
  | { kind: "split"; dir: SplitDir; ratio: number; a: SpaceSplitShape; b: SpaceSplitShape }

const SPACE_RATIO_EPS = 0.02

export type SpaceId =
  | "space:agent"
  | "space:observe"
  | "space:reconcile"
  | "space:bridge"
  | "space:trace"

export type ProductBundleId = "bundle:observe-core" | "bundle:reconcile-core"

/** Persisted Space ids renamed in place (never leave a ghost DIY tab). */
const LEGACY_SPACE_IDS: Readonly<Record<string, SpaceId>> = {
  "space:debug": "space:trace",
}

/**
 * Bump when curated Space widgets/ratios change so persisted product Spaces
 * rebuild to the new defaults (DIY-named views are left alone).
 */
export const SPACE_LAYOUT_VERSION = 6

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
    id: "space:trace",
    index: 0,
    name: "Trace",
    desc: "Inspect a thread and run",
    widgets: ["debug-inspector"],
  },
]

export const PRODUCT_BUNDLES: readonly ProductBundleDef[] = [
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

export function migrateSpaceId(id: string): string {
  return LEGACY_SPACE_IDS[id] ?? id
}

/** Map legacy Space ids (e.g. space:debug → space:trace) before merge/reapply. */
export function migrateProductSpaceViews(
  views: readonly WorkspaceView[],
): WorkspaceView[] {
  const renamed = views.map((view) => {
    const nextId = LEGACY_SPACE_IDS[view.id]
    if (!nextId) return view
    const name = spaceById(nextId)?.name ?? view.name
    return { ...view, id: nextId, name }
  })
  const seen = new Set<string>()
  const next: WorkspaceView[] = []
  for (const view of renamed) {
    if (seen.has(view.id)) continue
    seen.add(view.id)
    next.push(view)
  }
  return next
}

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
  if (spaceId === "space:trace") {
    return id("debug-inspector")
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
  const migrated = migrateProductSpaceViews(views)
  const byId = new Map(migrated.map((view) => [view.id, view]))
  const next = [...migrated]
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
  const migrated = migrateProductSpaceViews(views)
  const productIds = new Set(PRODUCT_SPACES.map((space) => space.id))
  const kept = migrated.filter((view) => !productIds.has(view.id as SpaceId))
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

function spaceSplitShape(
  node: SplitNode | null,
  typeById: ReadonlyMap<string, WidgetType>,
): SpaceSplitShape | null {
  if (!node) return null
  if (node.kind === "leaf") {
    const type = typeById.get(node.tileId)
    if (!type) return null
    return { kind: "leaf", type }
  }
  const a = spaceSplitShape(node.a, typeById)
  const b = spaceSplitShape(node.b, typeById)
  if (!a || !b) return null
  return { kind: "split", dir: node.dir, ratio: node.ratio, a, b }
}

function spaceSplitShapesEqual(
  a: SpaceSplitShape | null,
  b: SpaceSplitShape | null,
): boolean {
  if (a == null || b == null) return a == null && b == null
  if (a.kind !== b.kind) return false
  if (a.kind === "leaf" && b.kind === "leaf") return a.type === b.type
  if (a.kind !== "split" || b.kind !== "split") return false
  if (a.dir !== b.dir) return false
  if (Math.abs(a.ratio - b.ratio) > SPACE_RATIO_EPS) return false
  return spaceSplitShapesEqual(a.a, b.a) && spaceSplitShapesEqual(a.b, b.b)
}

function viewSplitShape(view: WorkspaceView): SpaceSplitShape | null {
  const typeById = new Map(view.tiles.map((tile) => [tile.id, tile.type] as const))
  return spaceSplitShape(view.split, typeById)
}

/**
 * True when a product Space still matches its curated default (widget set +
 * split ratios). DIY views and unknown ids are never "at default" for Reset.
 */
export function isProductSpaceAtDefault(view: WorkspaceView, rows = 24): boolean {
  if (!isProductSpaceId(view.id)) return false
  const def = spaceById(view.id)
  if (!def) return false
  const expectedTypes = [...def.widgets].sort()
  const actualTypes = view.tiles.map((tile) => tile.type).sort()
  if (
    expectedTypes.length !== actualTypes.length
    || expectedTypes.some((type, i) => type !== actualTypes[i])
  ) {
    return false
  }
  const fresh = buildSpaceView(def, rows)
  return spaceSplitShapesEqual(viewSplitShape(view), viewSplitShape(fresh))
}
