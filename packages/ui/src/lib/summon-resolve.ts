/**
 * Summon decisions — pure.
 *
 * Surfaces (widgets): Enter Keeps into the current layout (or focuses if
 * already present). Mod+Enter Peeks. Dedicated Spaces (Trace, Bridge) are
 * reached only via the Go column / Call Space — never by Enter on a surface.
 * Spaces navigate; presets open a home Space.
 */

import type { WidgetType } from "../types"
import {
  PRODUCT_BUNDLES,
  type ProductBundleDef,
  type ProductBundleId,
  type SpaceId,
} from "./spaces"

export { dedicatedSpaceForWidget } from "./spaces"

export type SummonOpenAction =
  | { type: "call-space"; spaceId: SpaceId }
  | { type: "peek-widget"; widgetType: WidgetType }
  | { type: "focus-tile"; widgetType: WidgetType }
  | {
      type: "open-bundle"
      spaceId: SpaceId
      ensureWidgets: readonly WidgetType[]
      focusType: WidgetType
    }
  | {
      type: "keep-widgets"
      widgets: readonly WidgetType[]
      focusType: WidgetType
    }

export function bundleDef(id: ProductBundleId): ProductBundleDef | undefined {
  return PRODUCT_BUNDLES.find((bundle) => bundle.id === id)
}

/** Enter on a Space = go there (not peek). */
export function resolveSummonSpaceEnter(spaceId: SpaceId): SummonOpenAction {
  return { type: "call-space", spaceId }
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
 * Enter on a bundle = Call home Space, ensure widgets, focus the
 * primary surface. Never peeks Threads alone maximized.
 */
export function resolveSummonBundleOpen(id: ProductBundleId): SummonOpenAction | null {
  const def = bundleDef(id)
  if (!def) return null
  return {
    type: "open-bundle",
    spaceId: def.homeSpace,
    ensureWidgets: def.widgets,
    focusType: def.focusType,
  }
}
