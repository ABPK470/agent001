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
import { type ReactNode } from "react"
import { useStore } from "../store"
import type { WidgetType } from "../types"

const WIDGET_LABELS: Record<WidgetType, string> = {
  "agent-chat": "Agent Chat",
  "term-chat": "MI:A Chat",
  "agent-viz": "Agent Viz",
  "run-status": "Run Status",
  "live-logs": "Event Stream",
  "audit-trail": "Audit Trail",
  "step-timeline": "Step Timeline",
  "tool-stats": "Tool Stats",
  "run-history": "Run History",
  "operator-env": "IOE",
  "debug-inspector": "Trace",
  "mymi-db": "Mymi DB",
  "active-users": "Active Users",
  "env-sync": "Sync",
  "operation-log": "Pipelines",
}

interface Props {
  widgetId: string
  viewId: string
  type: WidgetType
  children: ReactNode
}

export function WidgetFrame({ widgetId, viewId, type, children }: Props) {
  const removeWidget = useStore((s) => s.removeWidget)

  function handlePopOut(event?: React.MouseEvent<HTMLButtonElement>) {
    const state = useStore.getState()
    const params = new URLSearchParams()
    params.set("type", type)
    if (state.activeRunId) params.set("runId", state.activeRunId)

    // Transfer current live state so the popout starts with identical content
    try {
      localStorage.setItem("mia-popout-state", JSON.stringify({
        logs: state.logs,
        steps: state.steps,
        audit: state.audit,
        trace: state.trace,
        activeRunId: state.activeRunId,
      }))
    } catch { /* quota exceeded — popout will fall back to API fetch */ }

    // Size the popout to mirror the source widget when possible, capped to the screen
    const sourceEl = (event?.currentTarget as HTMLElement | undefined)?.closest(".react-grid-item") as HTMLElement | null
    const sourceRect = sourceEl?.getBoundingClientRect()
    const screenW = window.screen.availWidth
    const screenH = window.screen.availHeight
    const desiredW = Math.round(Math.max(420, Math.min(sourceRect?.width ?? 800, screenW * 0.8)))
    const desiredH = Math.round(Math.max(360, Math.min(sourceRect?.height ?? 600, screenH * 0.85)))
    const features = `width=${desiredW},height=${desiredH},menubar=no,toolbar=no,location=no,status=no`

    window.open(
      `/?widget=${type}&${params.toString()}`,
      `widget-${widgetId}`,
      features,
    )
  }

  const isTransparent = type === "term-chat"

  return (
    <div
      className={`flex flex-col h-full rounded-xl overflow-hidden ${isTransparent ? "bg-panel" : "bg-panel"}`}
    >
      {/* Header — drag handle */}
      <div className="widget-drag-handle flex items-center justify-between px-3 h-8 cursor-move shrink-0 select-none">
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
          {WIDGET_LABELS[type]}
        </span>
        <div className="widget-controls flex items-center gap-1">
          <button
            className="text-text-muted hover:text-text p-1 rounded transition-colors"
            onClick={(e) => handlePopOut(e)}
            title="Pop out"
          >
            <ExternalLink size={18} />
          </button>
          <button
            className="text-text-muted hover:text-error p-1 rounded transition-colors"
            onClick={() => removeWidget(viewId, widgetId)}
            title="Remove"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Content area — widget-content class used by draggableCancel in Canvas.tsx */}
      <div
        className={`widget-content flex-1 overflow-hidden ${isTransparent ? "p-0" : "p-3"}`}
      >
        {children}
      </div>
    </div>
  );
}
