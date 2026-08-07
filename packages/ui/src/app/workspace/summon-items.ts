/**
 * Summon catalog — operator dispatch, not a flat app launcher.
 *
 * Mental model (empty query = board):
 *   1. Go to Space  — product job destinations (⌘1–5) + custom layouts
 *   2. Open preset  — curated layouts
 *   3. Summon surface — Enter keeps / Mod+Enter peeks; bag keep/remove
 *
 * Search collapses the board to ranked matches; kinds stay visible.
 */

import type { LucideIcon } from "lucide-react"
import { Brain, LayoutPanelLeft } from "lucide-react"
import {
  isProductSpaceAtDefault,
  isProductSpaceId,
  PRODUCT_BUNDLES,
  PRODUCT_SPACES,
  spaceById,
  type ProductBundleId,
  type SpaceId,
} from "../../lib/spaces"
import type { WorkspaceView } from "../../lib/workspace-view"
import type { WidgetType } from "../../types"
import { WIDGET_ICONS } from "../../widgets/widget-icons"
import { catalogEntries } from "./widget-definitions"

/** Live layout — presets only appear when their home Space drifted. */
export type SummonCatalogContext = {
  views: readonly WorkspaceView[]
  viewportRows?: number
}

export type SummonItem =
  | {
      kind: "space"
      id: string
      name: string
      desc: string
      /** 1–5 = Call Space chord; 0 = custom layout (no Mod+N). */
      index: number
      custom?: boolean
      /** First tile type on a custom layout — icon hint. */
      primaryType?: WidgetType
    }
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
  if (
    type === "operation-log"
    || type === "live-logs"
    || type === "active-users"
  ) {
    return "platform"
  }
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

function diySpaceDesc(view: WorkspaceView): string {
  const n = view.tiles.length
  if (n === 0) return "Empty layout"
  if (n === 1) {
    const type = view.tiles[0]!.type
    const entry = catalogEntries().find((item) => item.type === type)
    return entry?.label ?? "1 surface"
  }
  return `${n} surfaces`
}

/**
 * Ops board order: product Spaces → custom layouts → presets → surfaces.
 * Reset presets only when that Space’s layout ≠ curated default
 * (same seam as toolbar “Reset Space”).
 */
export function listSummonItems(ctx: SummonCatalogContext): SummonItem[] {
  const rows = ctx.viewportRows ?? 24
  const spaces: SummonItem[] = [...PRODUCT_SPACES]
    .sort((a, b) => a.index - b.index)
    .map((space) => ({
      kind: "space" as const,
      id: space.id,
      name: space.name,
      desc: space.desc,
      index: space.index,
    }))

  const diySpaces: SummonItem[] = ctx.views
    .filter((view) => !isProductSpaceId(view.id))
    .map((view) => ({
      kind: "space" as const,
      id: view.id,
      name: view.name,
      desc: diySpaceDesc(view),
      index: 0,
      custom: true as const,
      primaryType: view.tiles[0]?.type,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  const bundles: SummonItem[] = PRODUCT_BUNDLES
    .filter((bundle) => {
      const view = ctx.views.find((item) => item.id === bundle.homeSpace)
      if (!view) return false
      return !isProductSpaceAtDefault(view, rows)
    })
    .map((bundle) => ({
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

  return [...spaces, ...diySpaces, ...bundles, ...widgets]
}

export function filterSummonItems(query: string, items: readonly SummonItem[]): SummonItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((item) => {
    const group =
      item.kind === "widget" ? WIDGET_GROUP_LABEL[item.group] : ""
    const custom = item.kind === "space" && item.custom ? "custom layout" : ""
    const hay = `${item.name} ${item.desc} ${item.kind} ${group} ${custom}`.toLowerCase()
    return hay.includes(q)
  })
}

export function summonItemKey(item: SummonItem): string {
  if (item.kind === "space") return `space:${item.id}`
  if (item.kind === "bundle") return `bundle:${item.id}`
  return `widget:${item.type}`
}

/**
 * Canonical glyph for a Summon row.
 * Agent Space/preset → Brain (Trace keeps Bug).
 * Custom layouts → LayoutPanelLeft (never borrow a surface icon like Event Stream).
 */
export function summonItemIcon(item: SummonItem): LucideIcon {
  if (item.kind === "widget") return WIDGET_ICONS[item.type]
  if (item.kind === "bundle") {
    if (item.homeSpace === "space:agent") return Brain
    return WIDGET_ICONS[item.focusType]
  }
  if (item.custom) return LayoutPanelLeft
  if (item.id === "space:agent") return Brain
  const primary = spaceById(item.id)?.widgets[0]
  if (!primary) {
    throw new Error(`Summon Space ${item.id} has no primary surface icon`)
  }
  return WIDGET_ICONS[primary]
}

/** Icon key for tests / diagnostics — Agent is Brain, not Trace’s Bug. */
export function summonItemIconType(item: SummonItem): WidgetType | "agent-brain" | "layout" {
  if (item.kind === "space" && item.custom) return "layout"
  if (item.kind === "space" && item.id === "space:agent") return "agent-brain"
  if (item.kind === "bundle" && item.homeSpace === "space:agent") return "agent-brain"
  if (item.kind === "widget") return item.type
  if (item.kind === "bundle") return item.focusType
  const primary = spaceById(item.id)?.widgets[0]
  if (!primary) {
    throw new Error(`Summon Space ${item.id} has no primary surface icon`)
  }
  return primary
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
      subtitle: "Pick a Space, layout, preset, or surface",
      primary: "open",
    }
  }
  if (item.kind === "space") {
    if (item.custom) {
      return {
        title: item.name,
        subtitle: `Go to layout — ${item.desc}`,
        primary: "go",
      }
    }
    const chord = item.index >= 1 && item.index <= 5 ? ` · ⌘${item.index}` : ""
    return {
      title: item.name,
      subtitle: `Go to Space${chord} — ${item.desc}`,
      primary: "go",
    }
  }
  if (item.kind === "bundle") {
    return {
      title: item.name,
      subtitle: `Restore default layout — ${item.desc}`,
      primary: "restore",
    }
  }
  if (opts.onSpace) {
    return {
      title: item.name,
      subtitle: `Focus on ${opts.spaceName ?? "this Space"} — Click / Space stages remove`,
      primary: "focus",
    }
  }
  return {
    title: item.name,
    subtitle: "Click stages · Enter keeps · right-click peeks",
    primary: "keep",
  }
}
