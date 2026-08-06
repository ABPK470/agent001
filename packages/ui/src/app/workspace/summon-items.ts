/**
 * Summon catalog — operator dispatch, not a flat app launcher.
 *
 * Mental model (empty query = board):
 *   1. Go to Space  — job destinations (⌘1–5)
 *   2. Open preset  — curated layouts
 *   3. Summon surface — Enter keeps / Mod+Enter peeks
 *
 * Search collapses the board to ranked matches; kinds stay visible.
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
  | {
      kind: "bundle"
      id: ProductBundleId
      name: string
      desc: string
      homeSpace: SpaceId
      focusType: WidgetType
    }
  | {
      kind: "widget"
      type: WidgetType
      name: string
      desc: string
      group: WidgetSummonGroup
    }

export type WidgetSummonGroup = "agent" | "platform" | "config" | "other"

export const WIDGET_GROUP_ORDER: readonly WidgetSummonGroup[] = [
  "agent",
  "platform",
  "config",
  "other",
]

export const WIDGET_GROUP_LABEL: Record<WidgetSummonGroup, string> = {
  agent: "Agent",
  platform: "Platform",
  config: "Config",
  other: "Other",
}

export function widgetSummonGroup(type: WidgetType): WidgetSummonGroup {
  if (
    type === "thread-nav"
    || type === "term-chat"
    || type === "debug-inspector"
    || type === "run-status"
  ) {
    return "agent"
  }
  if (type === "operation-log" || type === "live-logs") return "platform"
  if (
    type === "env-sync"
    || type === "entity-registry"
    || type === "sync-admin"
    || type === "bridge"
    || type.startsWith("sync-")
  ) {
    return "config"
  }
  return "other"
}

/** Ops board order: Spaces → presets → surfaces. */
export function listSummonItems(): SummonItem[] {
  const spaces: SummonItem[] = [...PRODUCT_SPACES]
    .sort((a, b) => a.index - b.index)
    .map((space) => ({
      kind: "space" as const,
      id: space.id,
      name: space.name,
      desc: space.desc,
      index: space.index,
    }))

  const bundles: SummonItem[] = PRODUCT_BUNDLES.map((bundle) => ({
    kind: "bundle" as const,
    id: bundle.id,
    name: bundle.name,
    desc: bundle.desc,
    homeSpace: bundle.homeSpace,
    focusType: bundle.focusType,
  }))

  // Full catalog — Trace/Bridge still Enter→their Space (never peek a second shell).
  const widgets: SummonItem[] = catalogEntries().map((entry) => ({
    kind: "widget" as const,
    type: entry.type,
    name: entry.label,
    desc: entry.desc,
    group: widgetSummonGroup(entry.type),
  }))

  // Stable widget order within groups for spatial memory.
  widgets.sort((a, b) => {
    if (a.kind !== "widget" || b.kind !== "widget") return 0
    const gi = WIDGET_GROUP_ORDER.indexOf(a.group) - WIDGET_GROUP_ORDER.indexOf(b.group)
    if (gi !== 0) return gi
    return a.name.localeCompare(b.name)
  })

  return [...spaces, ...bundles, ...widgets]
}

export function filterSummonItems(query: string, items: readonly SummonItem[]): SummonItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((item) => {
    const group =
      item.kind === "widget" ? WIDGET_GROUP_LABEL[item.group] : ""
    const hay = `${item.name} ${item.desc} ${item.kind} ${group}`.toLowerCase()
    return hay.includes(q)
  })
}

export function summonItemKey(item: SummonItem): string {
  if (item.kind === "space") return `space:${item.id}`
  if (item.kind === "bundle") return `bundle:${item.id}`
  return `widget:${item.type}`
}

export type SummonActionPreview = {
  title: string
  subtitle: string
  /** Short verb for the primary key. */
  primary: string
}

/** What Enter will do — always shown in the detail strip. */
export function summonActionPreview(
  item: SummonItem | null,
  opts: { onSpace: boolean; spaceName: string | null },
): SummonActionPreview {
  if (!item) {
    return {
      title: "Summon",
      subtitle: "Pick a Space, preset, or surface",
      primary: "open",
    }
  }
  if (item.kind === "space") {
    const chord = item.index >= 1 ? ` · ⌘${item.index}` : ""
    return {
      title: item.name,
      subtitle: `Go to Space${chord} — ${item.desc}`,
      primary: "go",
    }
  }
  if (item.kind === "bundle") {
    return {
      title: item.name,
      subtitle: `Open preset — ${item.desc}`,
      primary: "open",
    }
  }
  if (opts.onSpace) {
    return {
      title: item.name,
      subtitle: `Focus on ${opts.spaceName ?? "this Space"} — already present`,
      primary: "focus",
    }
  }
  return {
    title: item.name,
    subtitle: "Keep in this Space · ⌘Enter peeks",
    primary: "keep",
  }
}
