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
    History,
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
  { type: "run-status",    label: "Run Status",    desc: "Current run status, progress, and metadata",  Icon: Activity },
  { type: "live-logs",     label: "Event Stream",   desc: "Raw WebSocket event stream and system events", Icon: ScrollText },
  { type: "audit-trail",   label: "Audit Trail",   desc: "Immutable audit log of every action",         Icon: Shield },
  { type: "step-timeline", label: "Step Timeline",  desc: "Visual timeline of tool calls and steps",    Icon: Clock },
  { type: "tool-stats",    label: "Tool Stats",    desc: "Performance metrics per tool",                Icon: BarChart3 },
  { type: "run-history",   label: "Run History",   desc: "Browse past agent runs",                      Icon: History },
]

export function WidgetCatalog({ onClose }: Props) {
  const activeViewId = useStore((s) => s.activeViewId)
  const addWidget = useStore((s) => s.addWidget)
  const isMobile = useIsMobile()

  function handleAdd(type: WidgetType) {
    addWidget(activeViewId, type)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`bg-surface shadow-2xl ${
          isMobile
            ? "w-full h-full rounded-none p-5 flex flex-col"
            : "rounded-2xl p-6 w-[520px]"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-text">Add Widget</h2>
          <button
            className="text-text-muted hover:text-text p-2 -mr-2 rounded transition-colors"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>

        <div className={`grid gap-3 ${isMobile ? "grid-cols-1 overflow-y-auto flex-1" : "grid-cols-2"}`}>
          {CATALOG.map((item) => (
            <button
              key={item.type}
              className={`flex items-start gap-3 rounded-xl hover:bg-white/[0.04] active:bg-white/[0.06] cursor-pointer text-left group ${
                isMobile ? "p-4 border border-white/5" : "flex-col gap-2.5 p-4"
              }`}
              onClick={() => handleAdd(item.type)}
            >
              <div className={`flex items-center shrink-0 ${isMobile ? "w-10 h-10 justify-center rounded-lg bg-elevated" : "gap-2.5"}`}>
                <item.Icon size={isMobile ? 20 : 18} className="text-text-muted group-hover:text-text-secondary" />
                {!isMobile && (
                  <span className="text-sm font-medium text-text-secondary group-hover:text-text">
                    {item.label}
                  </span>
                )}
              </div>
              {isMobile ? (
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="text-sm font-medium text-text-secondary group-hover:text-text">
                    {item.label}
                  </span>
                  <span className="text-[13px] text-text-muted leading-snug">
                    {item.desc}
                  </span>
                </div>
              ) : (
                <span className="text-[13px] text-text-muted leading-snug">
                  {item.desc}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
