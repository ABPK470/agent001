/**
 * WidgetCatalog — modal for adding widgets to the canvas.
 *
 * Shows all available widget types with descriptions.
 * Click to add one to the active view.
 */

import { useStore } from "../store"
import type { WidgetType } from "../types"

interface Props {
  onClose: () => void
}

const CATALOG: Array<{ type: WidgetType, label: string, desc: string, icon: string }> = [
  { type: "agent-chat",    label: "Agent Chat",    desc: "Send goals to the agent and see responses",  icon: "💬" },
  { type: "run-status",    label: "Run Status",    desc: "Current run status, progress, and metadata",  icon: "📊" },
  { type: "live-logs",     label: "Live Logs",     desc: "Streaming log output from agent activity",    icon: "📜" },
  { type: "audit-trail",   label: "Audit Trail",   desc: "Immutable audit log of every action",         icon: "🔒" },
  { type: "step-timeline", label: "Step Timeline",  desc: "Visual timeline of tool calls and steps",    icon: "⏱️" },
  { type: "tool-stats",    label: "Tool Stats",    desc: "Performance metrics per tool",                icon: "📈" },
  { type: "run-history",   label: "Run History",   desc: "Browse past agent runs",                      icon: "📋" },
]

export function WidgetCatalog({ onClose }: Props) {
  const activeViewId = useStore((s) => s.activeViewId)
  const addWidget = useStore((s) => s.addWidget)

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
        className="bg-surface border border-border rounded-xl p-6 w-[520px] max-h-[80vh] overflow-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-text">Add Widget</h2>
          <button
            className="text-text-muted hover:text-text text-lg px-1"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {CATALOG.map((item) => (
            <button
              key={item.type}
              className="flex flex-col items-start gap-1.5 p-4 rounded-lg border border-border bg-base hover:border-accent/40 hover:bg-elevated transition-all text-left group"
              onClick={() => handleAdd(item.type)}
            >
              <div className="flex items-center gap-2">
                <span className="text-lg">{item.icon}</span>
                <span className="text-xs font-medium text-text group-hover:text-accent transition-colors">
                  {item.label}
                </span>
              </div>
              <span className="text-[11px] text-text-muted leading-snug">
                {item.desc}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
