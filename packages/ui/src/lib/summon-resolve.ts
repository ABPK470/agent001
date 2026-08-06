/**
 * Summon decisions — pure. Widgets peek; Spaces navigate; bundles open a home Space.
 */

import type { WidgetType } from "../types"
import {
  PRODUCT_BUNDLES,
  type ProductBundleDef,
  type ProductBundleId,
  type SpaceId,
} from "./spaces"

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
 * - already on active Space → focus that tile (never auto-maximize)
 * - otherwise → peek (layout untouched)
 */
export function resolveSummonWidgetEnter(
  widgetType: WidgetType,
  activeHasType: boolean,
): SummonOpenAction {
  if (activeHasType) return { type: "focus-tile", widgetType }
  return { type: "peek-widget", widgetType }
}

/** ⌘Enter on a widget = ensure Keep + focus (no maximize). */
export function resolveSummonWidgetKeep(widgetType: WidgetType): SummonOpenAction {
  return {
    type: "keep-widgets",
    widgets: [widgetType],
    focusType: widgetType,
  }
}

/**
 * Enter / ⌘Enter on a bundle = Call home Space, ensure widgets, focus the
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
