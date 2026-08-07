/**
 * Summon decisions — pure.
 *
 * Surfaces: Enter keeps (or focuses if present). Mod+Enter peeks.
 * Bag: stage absent → keep; stage present → remove; Enter applies both.
 * Spaces navigate (product Call or DIY go); presets restore curated defaults.
 */

import type { WidgetType } from "../types"
import {
  isProductSpaceId,
  PRODUCT_BUNDLES,
  type ProductBundleDef,
  type ProductBundleId,
  type SpaceId,
} from "./spaces"

export { dedicatedSpaceForWidget } from "./spaces"

export type SummonOpenAction =
  | { type: "call-space"; spaceId: SpaceId }
  | { type: "call-space-focus-pick"; spaceId: SpaceId; pickIndex: number }
  | { type: "go-view"; viewId: string }
  | { type: "go-view-focus-pick"; viewId: string; pickIndex: number }
  | { type: "peek-widget"; widgetType: WidgetType }
  | { type: "focus-tile"; widgetType: WidgetType }
  | {
      type: "open-bundle"
      spaceId: SpaceId
      focusType: WidgetType
      pickIndex?: number
    }
  | {
      type: "keep-widgets"
      widgets: readonly WidgetType[]
      focusType: WidgetType
    }
  | {
      type: "apply-widgets"
      keep: readonly WidgetType[]
      remove: readonly WidgetType[]
      focusType?: WidgetType
    }

export function bundleDef(id: ProductBundleId): ProductBundleDef | undefined {
  return PRODUCT_BUNDLES.find((bundle) => bundle.id === id)
}

/** Enter on a Space/layout = go there (product Call or DIY activate). */
export function resolveSummonSpaceEnter(viewId: string): SummonOpenAction {
  if (isProductSpaceId(viewId)) return { type: "call-space", spaceId: viewId }
  return { type: "go-view", viewId }
}

/**
 * Enter on a widget:
 * - already on active layout → focus first tile of that type (never duplicate)
 * - otherwise → Keep into the current layout
 */
export function resolveSummonWidgetEnter(
  widgetType: WidgetType,
  activeHasType: boolean,
): SummonOpenAction {
  if (activeHasType) return { type: "focus-tile", widgetType }
  return resolveSummonWidgetKeep(widgetType)
}

/** Mod+Enter on a widget = Peek overlay (layout untouched). */
export function resolveSummonWidgetPeek(widgetType: WidgetType): SummonOpenAction {
  return { type: "peek-widget", widgetType }
}

/** Keep factory — ensure widget on current layout + focus (no maximize). */
export function resolveSummonWidgetKeep(widgetType: WidgetType): SummonOpenAction {
  return {
    type: "keep-widgets",
    widgets: [widgetType],
    focusType: widgetType,
  }
}

/**
 * Keep many surfaces at once (Summon multi-pick).
 * Dedupes, drops empties; focus defaults to the last pick still in the bag.
 */
export function resolveSummonWidgetsKeep(
  widgets: readonly WidgetType[],
  focusType?: WidgetType,
): SummonOpenAction | null {
  const seen = new Set<WidgetType>()
  const unique: WidgetType[] = []
  for (const type of widgets) {
    if (seen.has(type)) continue
    seen.add(type)
    unique.push(type)
  }
  if (unique.length === 0) return null
  const focus =
    focusType && seen.has(focusType) ? focusType : unique[unique.length - 1]!
  return {
    type: "keep-widgets",
    widgets: unique,
    focusType: focus,
  }
}

/**
 * Apply a staged bag against what is already on the active layout:
 * absent → keep, present → remove.
 */
export function resolveSummonWidgetsApply(
  bag: readonly WidgetType[],
  presentTypes: ReadonlySet<string>,
  focusType?: WidgetType,
): SummonOpenAction | null {
  const seen = new Set<WidgetType>()
  const keep: WidgetType[] = []
  const remove: WidgetType[] = []
  for (const type of bag) {
    if (seen.has(type)) continue
    seen.add(type)
    if (presentTypes.has(type)) remove.push(type)
    else keep.push(type)
  }
  if (keep.length === 0 && remove.length === 0) return null
  const focus =
    focusType && keep.includes(focusType)
      ? focusType
      : keep.length > 0
        ? keep[keep.length - 1]
        : undefined
  return {
    type: "apply-widgets",
    keep,
    remove,
    focusType: focus,
  }
}

/**
 * Enter on a preset = Call home Space, restore curated widgets/splits,
 * focus the primary surface. Distinct from Call Space (navigate only).
 */
export function resolveSummonBundleOpen(id: ProductBundleId): SummonOpenAction | null {
  const def = bundleDef(id)
  if (!def) return null
  return {
    type: "open-bundle",
    spaceId: def.homeSpace,
    focusType: def.focusType,
  }
}

/**
 * Digit / blueprint click — land on Space/layout (or restore preset) and focus
 * the pickable leaf at `pickIndex` (blueprint paint order).
 */
export function resolveSummonBlueprintTileEnter(
  item: {
    kind: "space" | "bundle"
    id: string
    homeSpace?: SpaceId
    focusType?: WidgetType
    custom?: boolean
  },
  pickIndex: number,
): SummonOpenAction | null {
  if (pickIndex < 0) return null
  if (item.kind === "space") {
    if (isProductSpaceId(item.id) && !item.custom) {
      return {
        type: "call-space-focus-pick",
        spaceId: item.id,
        pickIndex,
      }
    }
    return {
      type: "go-view-focus-pick",
      viewId: item.id,
      pickIndex,
    }
  }
  const def = bundleDef(item.id as ProductBundleId)
  if (!def) return null
  return {
    type: "open-bundle",
    spaceId: def.homeSpace,
    focusType: def.focusType,
    pickIndex,
  }
}
