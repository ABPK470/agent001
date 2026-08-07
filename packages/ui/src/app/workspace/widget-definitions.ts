/**
 * Widget definitions — single registry for canvas chrome and catalog.
 *
 * Product Spaces (curated jobs) live in `lib/spaces.ts`:
 * Agent / Observe / Reconcile / Bridge / Trace. Summon: Enter keeps; Mod+Enter / right-click peeks.
 */

import type { ComponentType } from "react"
import type { WidgetType } from "../../types"
import { WIDGET_DEFAULTS } from "../../lib/widget-layout-defaults"
import type { WidgetSizeDefaults } from "../../lib/widget-layout-defaults"
import { widgetRegistry } from "../../widgets"
import { WIDGET_ICONS } from "../../widgets/widget-icons"

export type WidgetChrome = "flush" | "transparent" | "default"

/** Interior layout — shell wraps content per layout (split manages its own cards). */
export type WidgetLayout = "split" | "panel" | "canvas"

export interface WidgetDefinition {
  type: WidgetType
  component: ComponentType
  label: string
  desc: string
  icon: ComponentType<{ size?: number; className?: string }>
  defaultRect: WidgetSizeDefaults
  catalogVisible: boolean
  chrome: WidgetChrome
  layout: WidgetLayout
}

const CATALOG_META: Array<{
  type: WidgetType
  label: string
  desc: string
  catalogVisible?: boolean
}> = [
  {
    type: "thread-nav",
    label: "Threads",
    desc: "Select thread and run — drives Chat, Trace, and Run Status",
  },
  {
    type: "term-chat",
    label: "MI:A Chat",
    desc: "Send goals to the agent and see responses for the selected run",
  },
  {
    type: "run-status",
    label: "Run Status",
    desc: "Summary of the selected run — progress, tokens, and metadata",
  },
  {
    type: "debug-inspector",
    label: "Trace",
    desc: "Agent loop for the selected run — context, phases, calls, and work",
  },
  {
    type: "live-logs",
    label: "Event Stream",
    desc: "Platform event stream — live SSE across agents, sync, and system",
  },
  {
    type: "operation-log",
    label: "Pipelines",
    desc: "Platform operations — agent runs, sync, and Bridge at a glance",
  },
  {
    type: "env-sync",
    label: "Sync",
    desc: "Manual sync — pick source, target, entity, preview and execute",
  },
  {
    type: "entity-registry",
    label: "Entity Registry",
    desc: "Configure entities — browse, edit, and version sync definitions",
  },
  {
    type: "bridge",
    label: "Bridge",
    desc: "Move rows between connectors through a declarative transform",
  },
  {
    type: "sync-admin",
    label: "Sync Operations",
    desc: "Proposals, runs, evidence, approvals, connections, schedules, notify",
  },
  {
    type: "active-users",
    label: "Active Users",
    desc: "Who is online and what they are running",
  },
  {
    type: "mymi-db",
    label: "Mymi DB",
    desc: "Browse schemas, tables, and relationships (optional catalog view)",
  },
  { type: "sync-proposals", label: "Sync Proposals", desc: "Review sync proposals", catalogVisible: false },
  { type: "sync-approvals", label: "Sync Approvals", desc: "Approve sync changes", catalogVisible: false },
  { type: "sync-evidence", label: "Sync Evidence", desc: "Sync evidence records", catalogVisible: false },
]

function layoutForType(type: WidgetType): WidgetLayout {
  if (
    type === "entity-registry"
    || type === "sync-admin"
    || type.startsWith("sync-")
  ) return "split"
  /* Chat only — transparent canvas + explicit gutter. Review/agent widgets keep
     the bordered widget-panel; inner scroll gutter adds the second layer. */
  if (type === "term-chat") return "canvas"
  return "panel"
}

function chromeForType(type: WidgetType): WidgetChrome {
  if (type === "term-chat" || type === "thread-nav") return "transparent"
  if (
    type === "entity-registry"
    || type === "env-sync"
    || type === "live-logs"
    || type === "operation-log"
    || type === "debug-inspector"
    || type === "sync-admin"
    || type === "bridge"
    || type.startsWith("sync-")
  ) return "flush"
  return "default"
}

const DEFINITIONS: Record<WidgetType, WidgetDefinition> = {} as Record<WidgetType, WidgetDefinition>

for (const meta of CATALOG_META) {
  DEFINITIONS[meta.type] = {
    type: meta.type,
    component: widgetRegistry[meta.type],
    label: meta.label,
    desc: meta.desc,
    icon: WIDGET_ICONS[meta.type],
    defaultRect: WIDGET_DEFAULTS[meta.type],
    catalogVisible: meta.catalogVisible ?? true,
    chrome: chromeForType(meta.type),
    layout: layoutForType(meta.type),
  }
}

export function getWidgetDefinition(type: WidgetType): WidgetDefinition {
  return DEFINITIONS[type]
}

export function catalogEntries(): WidgetDefinition[] {
  return CATALOG_META
    .filter((meta) => meta.catalogVisible !== false)
    .map((meta) => DEFINITIONS[meta.type])
}

export function widgetComponent(type: WidgetType): ComponentType {
  return widgetRegistry[type]
}
