/**
 * WidgetCatalog — modal for adding widgets to the canvas.
 *
 * Shows all available widget types with descriptions.
 * Click to add one to the active view.
 */

import {
    Activity,
    BarChart3,
    Clock,
    Eye,
    History,
    LayoutGrid,
    ListTree,
    MessageSquare,
    ScrollText,
    Shield,
    X,
} from "lucide-react"
import type { ComponentType } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { useStore } from "../store"
import type { WidgetType } from "../types"

interface Props {
  onClose: () => void
}

const CATALOG: Array<{ type: WidgetType, label: string, desc: string, Icon: ComponentType<{ size?: number, className?: string }> }> = [
  { type: "agent-chat",    label: "Agent Chat",    desc: "Send goals to the agent and see responses",   Icon: MessageSquare },
  { type: "agent-trace",   label: "Agent Trace",   desc: "Execution trace: iterations, tool calls, results", Icon: ListTree },
  { type: "agent-viz",     label: "Agent Viz",     desc: "Live network visualization of agent activity", Icon: Eye },
  { type: "run-status",    label: "Run Status",    desc: "Current run status, progress, and metadata",  Icon: Activity },
  { type: "live-logs",     label: "Event Stream",   desc: "Raw WebSocket event stream and system events", Icon: ScrollText },
  { type: "audit-trail",   label: "Audit Trail",   desc: "Immutable audit log of every action",         Icon: Shield },
  { type: "step-timeline", label: "Step Timeline",  desc: "Visual timeline of tool calls and steps",    Icon: Clock },
  { type: "tool-stats",    label: "Tool Stats",    desc: "Performance metrics per tool",                Icon: BarChart3 },
  { type: "run-history",   label: "Run History",   desc: "Browse past agent runs",                      Icon: History },
]

export function WidgetCatalog({ onClose }: Props) {
  const activeViewId = useStore((s) => s.activeViewId)
  const views = useStore((s) => s.views)
  const addWidget = useStore((s) => s.addWidget)
  const removeWidget = useStore((s) => s.removeWidget)
  const isMobile = useIsMobile()

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className={`bg-surface shadow-2xl ${
          isMobile
            ? "w-full h-full rounded-none flex flex-col"
            : "rounded-2xl w-[520px] max-h-[85vh] flex flex-col"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2.5">
            <LayoutGrid size={20} className="text-text-muted" />
            <h2 className="text-lg font-semibold text-text">Widgets</h2>
          </div>
          <button
            className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        <div className={`grid gap-2.5 p-5 overflow-y-auto ${isMobile ? "grid-cols-1 flex-1" : "grid-cols-2"}`}>
          {CATALOG.map((item) => {
            const isActive = activeTypes.has(item.type)
            return (
              <button
                key={item.type}
                className={`relative flex items-center gap-3.5 rounded-xl cursor-pointer text-left p-4 transition-colors border ${
                  isActive
                    ? "border-accent/25 bg-accent/[0.08]"
                    : "border-white/[0.04] bg-white/[0.02] hover:bg-white/[0.05]"
                }`}
                onClick={() => handleToggle(item.type)}
              >
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                  isActive ? "bg-accent/15" : "bg-white/[0.05]"
                }`}>
                  <item.Icon size={18} className={isActive ? "text-accent" : "text-text-muted"} />
                </div>
                <div className="flex-1 min-w-0">
                  <span className={`text-sm font-medium block ${isActive ? "text-accent" : "text-text"}`}>
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
