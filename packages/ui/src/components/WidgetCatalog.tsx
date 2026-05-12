/**
 * WidgetCatalog — modal for adding widgets to the canvas.
 *
 * Shows all available widget types with descriptions.
 * Click to add one to the active view.
 */

import {
  Activity,
  BarChart3,
  Bug,
  Clock,
  Database,
  Eye,
  History,
  LayoutDashboard,
  MessageSquare,
  ScrollText,
  Shield,
  Ship,
  X,
} from "lucide-react"
import type { ComponentType } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import type { WidgetType } from "../types"
import { VISITOR_WIDGETS } from "../types"

interface Props {
  onClose: () => void
}

const CATALOG: Array<{ type: WidgetType, label: string, desc: string, Icon: ComponentType<{ size?: number, className?: string }> }> = [
  { type: "term-chat",     label: "MI:A Chat",     desc: "Send goals to the agent and see responses",   Icon: MessageSquare },
  { type: "env-sync",      label: "Sync",          desc: "Pick source, target, entity, preview and execute changes", Icon: Ship },
  { type: "mymi-db",       label: "Mymi DB",       desc: "Browse MyMI DB schemas, tables, views, and preview data", Icon: Database },
  { type: "operation-log", label: "Pipelines",     desc: "Pipeline monitor — agent runs, sync",         Icon: History },
  { type: "live-logs",     label: "Event Stream",  desc: "Real-time SSE event stream",                  Icon: ScrollText },
  { type: "run-history",   label: "Run History",   desc: "Browse past agent runs",                      Icon: History },
  { type: "agent-chat",    label: "Agent Chat",    desc: "Older version of agent chat",                 Icon: MessageSquare },
  { type: "agent-viz",     label: "Agent Viz",     desc: "Live network visualization of agent activity", Icon: Eye },
  { type: "run-status",    label: "Run Status",    desc: "Current run status, progress, and metadata",  Icon: Activity },
  { type: "audit-trail",   label: "Audit Trail",   desc: "Immutable audit log of every action",         Icon: Shield },
  { type: "step-timeline", label: "Step Timeline", desc: "Visual timeline of tool calls and steps",     Icon: Clock },
  { type: "tool-stats",    label: "Tool Stats",    desc: "Performance metrics per tool",                Icon: BarChart3 },
  { type: "operator-env",  label: "IOE",           desc: "IDE like, all data, full control",            Icon: LayoutDashboard },
  { type: "debug-inspector", label: "Trace",       desc: "System prompts, tool resolution, LLM requests & responses", Icon: Bug },
  { type: "active-users",  label: "Active Users",  desc: "Who's online, what they're running",          Icon: Activity },
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className={`bg-surface shadow-2xl rounded-xl sm:rounded-2xl flex flex-col ${
          isMobile
            ? "w-full h-full"
            : "w-[820px] max-w-full max-h-[85vh]"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            <LayoutDashboard size={20} className="text-text-muted" />
            <h2 className="text-lg font-semibold text-text">Widgets</h2>
          </div>
          <button
            className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className={`grid gap-2.5 p-5 overflow-y-auto ${isMobile ? "grid-cols-1 flex-1" : "grid-cols-3"}`}>
          {/* Show the full catalogue to everyone so visitors see what's
              available. Cards for admin-only widgets render disabled
              (greyed) for non-admins; admins see them fully active. */}
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
      </div>
    </div>
  )
}
