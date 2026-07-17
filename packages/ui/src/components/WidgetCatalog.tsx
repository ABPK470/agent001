/**
 * WidgetCatalog — modal for adding widgets to the canvas.
 */

import { LayoutDashboard } from "lucide-react"
import type { ComponentType } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import type { WidgetType } from "../types"
import { VISITOR_WIDGETS } from "../types"
import { ModalShell } from "../widgets/entity-registry/ModalShell"
import { modalViewerPanelClass } from "../widgets/entity-registry/modal-overlay"
import { WIDGET_ICONS } from "../widgets/widget-icons"

interface Props {
  onClose: () => void
}

const CATALOG: Array<{ type: WidgetType, label: string, desc: string, Icon: ComponentType<{ size?: number, className?: string }> }> = [
  { type: "thread-nav",    label: "Threads",       desc: "Select the active thread and run for chat widgets", Icon: WIDGET_ICONS["thread-nav"] },
  { type: "term-chat",     label: "MI:A Chat",     desc: "Send goals to the agent and see responses",   Icon: WIDGET_ICONS["term-chat"] },
  { type: "env-sync",      label: "Sync",          desc: "Pick source, target, entity, preview and execute changes", Icon: WIDGET_ICONS["env-sync"] },
  { type: "mymi-db",       label: "Mymi DB",       desc: "Browse MyMI DB schemas, tables, views, and preview data", Icon: WIDGET_ICONS["mymi-db"] },
  { type: "operation-log", label: "Pipelines",     desc: "Pipeline monitor — agent runs, sync, Bridge", Icon: WIDGET_ICONS["operation-log"] },
  { type: "live-logs",     label: "Event Stream",  desc: "Real-time SSE event stream",                  Icon: WIDGET_ICONS["live-logs"] },
  { type: "run-history",   label: "Run History",   desc: "Browse past agent runs",                      Icon: WIDGET_ICONS["run-history"] },
  { type: "agent-chat",    label: "Agent Chat",    desc: "Older version of agent chat",                 Icon: WIDGET_ICONS["agent-chat"] },
  { type: "run-status",    label: "Run Status",    desc: "Current run status, progress, and metadata",  Icon: WIDGET_ICONS["run-status"] },
  { type: "step-timeline", label: "Step Timeline", desc: "Visual timeline of tool calls and steps",     Icon: WIDGET_ICONS["step-timeline"] },
  { type: "debug-inspector", label: "Trace",       desc: "System prompts, tool resolution, LLM requests & responses", Icon: WIDGET_ICONS["debug-inspector"] },
  { type: "active-users",  label: "Active Users",  desc: "Who's online, what they're running",          Icon: WIDGET_ICONS["active-users"] },
  { type: "entity-registry", label: "Entity Registry", desc: "Browse, edit, and version entity definitions for the sync platform", Icon: WIDGET_ICONS["entity-registry"] },
  { type: "sync-admin",     label: "Sync Operations", desc: "Proposals, runs, evidence, approvals, connections, schedules, notify routes", Icon: WIDGET_ICONS["sync-admin"] },
  { type: "bridge",  label: "Bridge",   desc: "Move rows between connectors through a declarative transform", Icon: WIDGET_ICONS["bridge"] },
]

export function WidgetCatalog({ onClose }: Props) {
  const activeViewId = useStore((s) => s.activeViewId)
  const views = useStore((s) => s.views)
  const addWidget = useStore((s) => s.addWidget)
  const removeWidget = useStore((s) => s.removeWidget)
  const isMobile = useIsMobile()
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const activeView = views.find((v) => v.id === activeViewId)
  const activeTypes = new Set(activeView?.widgets.map((w) => w.type) ?? [])

  function handleToggle(type: WidgetType) {
    const existing = activeView?.widgets.find((w) => w.type === type)
    if (existing) {
      removeWidget(activeViewId, existing.id)
    } else {
      addWidget(activeViewId, type)
    }
  }

  return (
    <ModalShell
      title="Widgets"
      subtitle="Add or remove panels on your workspace canvas."
      icon={<LayoutDashboard size={20} className="text-text-muted" />}
      onClose={onClose}
      widthClass={modalViewerPanelClass(isMobile)}
    >
      <div
        className={`min-h-0 flex-1 overflow-y-auto p-5 show-scrollbar grid gap-2.5 ${
          isMobile ? "grid-cols-1" : "grid-cols-2 lg:grid-cols-3"
        }`}
      >
        {CATALOG.map((item) => {
          const isActive = activeTypes.has(item.type)
          const isAllowed = isAdmin || VISITOR_WIDGETS.has(item.type)
          return (
            <button
              key={item.type}
              disabled={!isAllowed}
              title={isAllowed ? undefined : "Available to admins only"}
              className={`relative flex items-center gap-3.5 rounded-xl text-left p-4 transition-colors border ${
                !isAllowed
                  ? "border-border-subtle bg-overlay-1 opacity-45 cursor-not-allowed"
                  : isActive
                    ? "border-accent/25 bg-accent/[0.08] cursor-pointer"
                    : "border-border-subtle bg-overlay-1 hover:bg-overlay-2 cursor-pointer"
              }`}
              onClick={() => { if (isAllowed) handleToggle(item.type) }}
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                isActive && isAllowed ? "bg-accent/15" : "bg-overlay-2"
              }`}>
                <item.Icon size={18} className={isActive && isAllowed ? "text-accent" : "text-text-muted"} />
              </div>
              <div className="flex-1 min-w-0">
                <span className={`text-sm font-medium block ${isActive && isAllowed ? "text-accent" : "text-text"}`}>
                  {item.label}
                </span>
                <span className="text-[13px] text-text-muted leading-snug block mt-0.5">
                  {item.desc}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </ModalShell>
  )
}
