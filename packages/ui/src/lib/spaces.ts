/**
 * Product Spaces — curated job landings with fixed default autolayouts.
 * Named DIY views remain secondary; Spaces are the commercial landing.
 *
 * Role (`isAdmin`): operators see Agent / Observe / Reconcile(Sync-only) /
 * Trace. Bridge + Users + Entity Registry are admin-only. Call Space Mod+N
 * indices recompact over the visible set.
 *
 * Defaults (ratios of the canvas):
 * - Observe: Pipelines 70% | Event stream 30%
 * - Trace: Trace alone (self-sufficient scope bar + drawer)
 * - Reconcile: Sync 50% | Entity registry 50% (admin) · Sync alone (operator)
 * - Agent: Trace 60% | Chat 40%
 * - Bridge: Bridge alone (admin)
 */

import { canOpenWidget } from "@mia/shared-types"
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
  | "space:users"

export type ProductBundleId =
  | "bundle:agent-core"
  | "bundle:observe-core"
  | "bundle:reconcile-core"
  | "bundle:users-core"

/** Persisted Space ids renamed in place (never leave a ghost DIY tab). */
const LEGACY_SPACE_IDS: Readonly<Record<string, SpaceId>> = {
  "space:debug": "space:trace",
}

/**
 * Bump when curated Space widgets/ratios change so persisted product Spaces
 * rebuild to the new defaults (DIY-named views are left alone).
 */
export const SPACE_LAYOUT_VERSION = 9

/** Admin-only product Spaces — absent from operator console. */
const ADMIN_ONLY_SPACE_IDS: ReadonlySet<SpaceId> = new Set([
  "space:bridge",
  "space:users",
])

export function canSeeSpace(spaceId: SpaceId, isAdmin: boolean): boolean {
  if (ADMIN_ONLY_SPACE_IDS.has(spaceId)) return isAdmin
  return true
}

export interface ProductSpaceDef {
  id: SpaceId
  /** 1–5 = Call Space (Mod+1…5). */
  index: number
  name: string
  desc: string
  widgets: readonly WidgetType[]
}

export interface ProductBundleDef {
  id: ProductBundleId
  name: string
  desc: string
  /** Space whose curated default this preset restores. */
  homeSpace: SpaceId
  /** Tile to focus after restore (never auto-maximize). */
  focusType: WidgetType
  /** Documented widget set — must match the home Space default. */
  widgets: readonly WidgetType[]
}

export const PRODUCT_SPACES: readonly ProductSpaceDef[] = [
  {
    id: "space:agent",
    index: 1,
    name: "Agent",
    desc: "Trace with chat",
    widgets: ["debug-inspector", "term-chat"],
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
    index: 5,
    name: "Trace",
    desc: "Inspect a thread and run",
    widgets: ["debug-inspector"],
  },
  {
    id: "space:users",
    /** No Mod+N Call Space — open via Summon / tab. */
    index: 6,
    name: "Users",
    desc: "Who is online and what they are running",
    widgets: ["active-users"],
  },
]

export const PRODUCT_BUNDLES: readonly ProductBundleDef[] = [
  {
    id: "bundle:agent-core",
    name: "Agent · reset",
    desc: "Restore Trace 60% · Chat 40%",
    homeSpace: "space:agent",
    focusType: "debug-inspector",
    widgets: ["debug-inspector", "term-chat"],
  },
  {
    id: "bundle:observe-core",
    name: "Observe · reset",
    desc: "Restore Pipelines 70% · Event stream 30%",
    homeSpace: "space:observe",
    focusType: "operation-log",
    widgets: ["operation-log", "live-logs"],
  },
  {
    id: "bundle:reconcile-core",
    name: "Reconcile · reset",
    desc: "Restore Sync · Entity registry 50/50",
    homeSpace: "space:reconcile",
    focusType: "env-sync",
    widgets: ["env-sync", "entity-registry"],
  },
  {
    id: "bundle:users-core",
    name: "Users · reset",
    desc: "Restore Active Users full-bleed",
    homeSpace: "space:users",
    focusType: "active-users",
    widgets: ["active-users"],
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

/** Role-adjusted Space def (Reconcile widgets + copy). */
export function spaceDefForRole(
  def: ProductSpaceDef,
  isAdmin: boolean,
): ProductSpaceDef {
  if (def.id !== "space:reconcile" || isAdmin) return def
  return {
    ...def,
    desc: "Sync",
    widgets: ["env-sync"],
  }
}

/**
 * Product Spaces visible for this role, with Call indices recompacted to
 * contiguous Mod+1…N (no dead Bridge slot for operators).
 */
export function spacesForRole(isAdmin: boolean): ProductSpaceDef[] {
  const visible = PRODUCT_SPACES
    .filter((space) => canSeeSpace(space.id, isAdmin))
    .map((space) => spaceDefForRole(space, isAdmin))
  let callIndex = 1
  return visible.map((space) => {
    if (space.index >= 1 && space.index <= 5) {
      return { ...space, index: callIndex++ }
    }
    return space
  })
}

export function bundlesForRole(isAdmin: boolean): ProductBundleDef[] {
  return PRODUCT_BUNDLES
    .filter((bundle) => canSeeSpace(bundle.homeSpace, isAdmin))
    .map((bundle) => {
      if (bundle.homeSpace !== "space:reconcile" || isAdmin) return bundle
      return {
        ...bundle,
        desc: "Restore Sync full-bleed",
        widgets: ["env-sync"] as const,
      }
    })
}

export function spaceById(
  id: string,
  isAdmin = true,
): ProductSpaceDef | undefined {
  const raw = PRODUCT_SPACES.find((space) => space.id === id)
  if (!raw || !canSeeSpace(raw.id, isAdmin)) return undefined
  return spaceDefForRole(raw, isAdmin)
}

/** Call Space by recompacted Mod+N index for this role (Mod+1…5 only). */
export function spaceByIndex(
  index: number,
  isAdmin = true,
): ProductSpaceDef | undefined {
  if (index < 1 || index > 5) return undefined
  return spacesForRole(isAdmin).find((space) => space.index === index)
}

export function bundleById(
  id: string,
  isAdmin = true,
): ProductBundleDef | undefined {
  return bundlesForRole(isAdmin).find((bundle) => bundle.id === id)
}

export function isProductSpaceId(id: string): id is SpaceId {
  return PRODUCT_SPACES.some((space) => space.id === id)
}

/** Space whose only widget is this type — Summon Go path, not peek. */
export function dedicatedSpaceForWidget(
  type: WidgetType,
  isAdmin = true,
): SpaceId | null {
  for (const space of spacesForRole(isAdmin)) {
    if (space.widgets.length === 1 && space.widgets[0] === type) return space.id
  }
  return null
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
    if (byType.has("entity-registry")) {
      return vSplit(0.5, id("env-sync"), id("entity-registry"))
    }
    return id("env-sync")
  }
  if (spaceId === "space:agent") {
    // Trace 60% | Chat 40%
    return vSplit(0.6, id("debug-inspector"), id("term-chat"))
  }
  if (spaceId === "space:bridge") {
    return id("bridge")
  }
  if (spaceId === "space:users") {
    return id("active-users")
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

/** Drop tiles the role cannot open; repair split geometry. */
export function stripUnauthorizedTiles(
  views: readonly WorkspaceView[],
  isAdmin: boolean,
  rows = 24,
): WorkspaceView[] {
  return views.map((view) => {
    const tiles = view.tiles.filter((tile) => canOpenWidget(tile.type, isAdmin))
    if (tiles.length === view.tiles.length) return view
    return syncViewGeometry({ ...view, tiles, split: view.split }, rows, COLS)
  })
}

/** Ensure every role-visible product Space exists; drop admin-only Spaces for operators. */
export function mergeProductSpaces(
  views: readonly WorkspaceView[],
  rows = 24,
  isAdmin = true,
): WorkspaceView[] {
  const roleSpaces = spacesForRole(isAdmin)
  const roleIds = new Set(roleSpaces.map((space) => space.id))
  const migrated = migrateProductSpaceViews(views)
  const stripped = stripUnauthorizedTiles(
    migrated.filter((view) => {
      if (!isProductSpaceId(view.id)) return true
      return roleIds.has(view.id)
    }),
    isAdmin,
    rows,
  )
  const byId = new Map(stripped.map((view) => [view.id, view]))
  const next = [...stripped]
  for (const def of roleSpaces) {
    if (byId.has(def.id)) continue
    const built = buildSpaceView(def, rows)
    next.push(built)
    byId.set(def.id, built)
  }
  return next
}

/**
 * Rebuild all role-visible product Spaces to the current curated defaults.
 * DIY-named views are preserved (illegal tiles stripped).
 */
export function reapplyProductSpaceLayouts(
  views: readonly WorkspaceView[],
  rows = 24,
  isAdmin = true,
): WorkspaceView[] {
  const roleSpaces = spacesForRole(isAdmin)
  const productIds = new Set(PRODUCT_SPACES.map((space) => space.id))
  const migrated = migrateProductSpaceViews(views)
  const kept = stripUnauthorizedTiles(
    migrated.filter((view) => !productIds.has(view.id as SpaceId)),
    isAdmin,
    rows,
  )
  const rebuilt = roleSpaces.map((def) => buildSpaceView(def, rows))
  return [...kept, ...rebuilt]
}

/** Replace a Space’s tiles/split with the product default for this role. */
export function resetSpaceView(
  views: readonly WorkspaceView[],
  spaceId: SpaceId,
  rows = 24,
  isAdmin = true,
): WorkspaceView[] {
  const def = spaceById(spaceId, isAdmin)
  if (!def) return [...views]
  const built = buildSpaceView(def, rows)
  const has = views.some((view) => view.id === spaceId)
  if (!has) return [...views, built]
  return views.map((view) => (view.id === spaceId ? built : view))
}

export function primarySpaceForWidget(
  type: WidgetType,
  isAdmin = true,
): SpaceId | null {
  for (const space of spacesForRole(isAdmin)) {
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
export function isProductSpaceAtDefault(
  view: WorkspaceView,
  rows = 24,
  isAdmin = true,
): boolean {
  if (!isProductSpaceId(view.id)) return false
  const def = spaceById(view.id, isAdmin)
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
