/**
 * WidgetFrame — container chrome for each dashboard widget.
 *
 * Provides:
 *   - Drag handle (header bar)
 *   - Title with widget type label
 *   - Controls: pop-out to new window, close
 *   - Content area
 */

import { ExternalLink, X } from "lucide-react"
import type { ReactNode } from "react"
import { useStore } from "../store"
import type { WidgetType } from "../types"

const WIDGET_LABELS: Record<WidgetType, string> = {
  "agent-chat": "Agent Chat",
  "agent-trace": "Agent Trace",
  "agent-viz": "Agent Viz",
  "run-status": "Run Status",
  "live-logs": "Event Stream",
  "audit-trail": "Audit Trail",
  "step-timeline": "Step Timeline",
  "tool-stats": "Tool Stats",
  "run-history": "Run History",
  "command-center": "Command Center",
  "trajectory-replay": "Trajectory Replay",
  "operator-env": "Operator Environment",
}

interface Props {
  widgetId: string
  viewId: string
  type: WidgetType
  children: ReactNode
}

export function WidgetFrame({ widgetId, viewId, type, children }: Props) {
  const removeWidget = useStore((s) => s.removeWidget)

  function handlePopOut() {
    const activeRunId = useStore.getState().activeRunId
    const params = new URLSearchParams()
    params.set("type", type)
    if (activeRunId) params.set("runId", activeRunId)
    window.open(
      `/?widget=${type}&${params.toString()}`,
      `widget-${widgetId}`,
      "width=600,height=500,menubar=no,toolbar=no",
    )
  }

  return (
    <div className="flex flex-col h-full bg-surface rounded-xl overflow-hidden">
      {/* Header — drag handle */}
      <div className="widget-drag-handle flex items-center justify-between px-3 h-8 cursor-move shrink-0 select-none">
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
          {WIDGET_LABELS[type]}
        </span>
        <div className="widget-controls flex items-center gap-1">
          <button
            className="text-text-muted hover:text-text p-1 rounded transition-colors"
            onClick={handlePopOut}
            title="Pop out"
          >
            <ExternalLink size={14} />
          </button>
          <button
            className="text-text-muted hover:text-error p-1 rounded transition-colors"
            onClick={() => removeWidget(viewId, widgetId)}
            title="Remove"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden p-3">
        {children}
      </div>
    </div>
  )
}
