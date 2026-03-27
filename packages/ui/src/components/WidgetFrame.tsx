/**
 * WidgetFrame — container chrome for each dashboard widget.
 *
 * Provides:
 *   - Drag handle (header bar)
 *   - Title with widget type label
 *   - Controls: pop-out to new window, close
 *   - Content area with overflow scroll
 */

import type { ReactNode } from "react"
import { useStore } from "../store"
import type { WidgetType } from "../types"

const WIDGET_LABELS: Record<WidgetType, string> = {
  "agent-chat": "Agent Chat",
  "run-status": "Run Status",
  "live-logs": "Live Logs",
  "audit-trail": "Audit Trail",
  "step-timeline": "Step Timeline",
  "tool-stats": "Tool Stats",
  "run-history": "Run History",
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
    <div className="flex flex-col h-full bg-surface rounded-lg border border-border overflow-hidden">
      {/* Header — drag handle */}
      <div className="widget-drag-handle flex items-center justify-between px-3 h-7 border-b border-border cursor-move shrink-0 select-none">
        <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wider">
          {WIDGET_LABELS[type]}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="text-text-muted hover:text-text text-[11px] px-1 transition-colors"
            onClick={handlePopOut}
            title="Pop out"
          >
            ⧉
          </button>
          <button
            className="text-text-muted hover:text-error text-[11px] px-1 transition-colors"
            onClick={() => removeWidget(viewId, widgetId)}
            title="Remove"
          >
            ×
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3">
        {children}
      </div>
    </div>
  )
}
