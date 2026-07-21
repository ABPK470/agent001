/**
 * Widget definitions — single registry for canvas chrome and catalog.
 */

import type { ComponentType } from "react"
import type { WidgetType } from "../../types"
import { WIDGET_DEFAULTS } from "../../lib/widget-layout-defaults"
import type { WidgetSizeDefaults } from "../../lib/widget-layout-defaults"
import { widgetRegistry } from "../../widgets"
import { WIDGET_ICONS } from "../../widgets/widget-icons"

export type WidgetChrome = "flush" | "transparent" | "default"

export interface WidgetDefinition {
  type: WidgetType
  component: ComponentType
  label: string
  desc: string
  icon: ComponentType<{ size?: number; className?: string }>
  defaultRect: WidgetSizeDefaults
  catalogVisible: boolean
  chrome: WidgetChrome
}

const CATALOG_META: Array<{
  type: WidgetType
  label: string
  desc: string
  catalogVisible?: boolean
}> = [
  { type: "thread-nav", label: "Threads", desc: "Select the active thread and run for chat widgets" },
  { type: "term-chat", label: "MI:A Chat", desc: "Send goals to the agent and see responses" },
  { type: "live-logs", label: "Event Stream", desc: "Real-time SSE event stream" },
  { type: "env-sync", label: "Sync", desc: "Pick source, target, entity, preview and execute changes" },
  { type: "entity-registry", label: "Entity Registry", desc: "Browse, edit, and version entity definitions for the sync platform" },
  { type: "operation-log", label: "Pipelines", desc: "Pipeline monitor — agent runs, sync, Bridge" },
  { type: "bridge", label: "Bridge", desc: "Move rows between connectors through a declarative transform" },
  { type: "debug-inspector", label: "Trace", desc: "Agent loop outline — context, plan phases, LLM calls, and between-call work" },
  { type: "active-users", label: "Active Users", desc: "Who's online, what they're running" },
  { type: "mymi-db", label: "Mymi DB", desc: "Browse MyMI DB schemas, tables, views, and preview data" },
  { type: "run-history", label: "Run History", desc: "Browse past agent runs" },
  { type: "run-status", label: "Run Status", desc: "Current run status, progress, and metadata" },
  { type: "step-timeline", label: "Step Timeline", desc: "Visual timeline of tool calls and steps" },
  { type: "sync-admin", label: "Sync Operations", desc: "Proposals, runs, evidence, approvals, connections, schedules, notify routes" },
  { type: "agent-chat", label: "Agent Chat", desc: "Older version of agent chat" },
  { type: "sync-proposals", label: "Sync Proposals", desc: "Review sync proposals", catalogVisible: false },
  { type: "sync-approvals", label: "Sync Approvals", desc: "Approve sync changes", catalogVisible: false },
  { type: "sync-evidence", label: "Sync Evidence", desc: "Sync evidence records", catalogVisible: false },
]

function chromeForType(type: WidgetType): WidgetChrome {
  if (type === "term-chat" || type === "thread-nav") return "transparent"
  if (
    type === "entity-registry"
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
