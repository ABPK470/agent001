/**
 * Spotlight Summon catalog — Spaces, bundles, widgets (one searchable list).
 */

import type { WidgetType } from "../../types"
import {
  PRODUCT_BUNDLES,
  PRODUCT_SPACES,
  type ProductBundleId,
  type SpaceId,
} from "../../lib/spaces"
import { catalogEntries } from "./widget-definitions"

export type SummonItem =
  | { kind: "space"; id: SpaceId; name: string; desc: string; index: number }
  | { kind: "bundle"; id: ProductBundleId; name: string; desc: string; peekType: WidgetType }
  | { kind: "widget"; type: WidgetType; name: string; desc: string }

export function listSummonItems(): SummonItem[] {
  const spaces: SummonItem[] = PRODUCT_SPACES.map((space) => ({
    kind: "space",
    id: space.id,
    name: space.name,
    desc: space.desc,
    index: space.index,
  }))
  const bundles: SummonItem[] = PRODUCT_BUNDLES.map((bundle) => ({
    kind: "bundle",
    id: bundle.id,
    name: bundle.name,
    desc: bundle.desc,
    peekType: bundle.widgets[0]!,
  }))
  const widgets: SummonItem[] = catalogEntries().map((entry) => ({
    kind: "widget",
    type: entry.type,
    name: entry.label,
    desc: entry.desc,
  }))
  return [...spaces, ...bundles, ...widgets]
}

export function filterSummonItems(query: string, items: readonly SummonItem[]): SummonItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((item) => {
    const hay = `${item.name} ${item.desc} ${item.kind}`.toLowerCase()
    return hay.includes(q)
  })
}

export function summonItemKey(item: SummonItem): string {
  if (item.kind === "space") return `space:${item.id}`
  if (item.kind === "bundle") return `bundle:${item.id}`
  return `widget:${item.type}`
}
