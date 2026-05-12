/**
 * WidgetModal — opens any widget as a floating modal overlay.
 *
 * Used when a notification action points to a widget that isn't
 * in the current view. The modal shows the widget with full
 * functionality plus an "Add to view" button to embed it.
 */

import { Maximize2, Plus, X } from "lucide-react"
import { useStore } from "../store"
import type { WidgetType } from "../types"
import { widgetRegistry } from "../widgets"

const WIDGET_LABELS: Record<WidgetType, string> = {
  "agent-chat": "Agent Chat",
  "agent-viz": "Agent Viz",
  "run-status": "Run Status",
  "live-logs": "Event Stream",
  "audit-trail": "Audit Trail",
  "step-timeline": "Step Timeline",
  "tool-stats": "Tool Stats",
  "run-history": "Run History",
  "operator-env": "IOE",
  "debug-inspector": "Trace",
  "mymi-db": "MyMI Database",
  "active-users": "Active Users",
  "env-sync": "Sync",
  "operation-log": "Pipelines",
}

export function WidgetModal() {
  const modalWidget = useStore((s) => s.modalWidget)
  const closeModalWidget = useStore((s) => s.closeModalWidget)
  const addWidget = useStore((s) => s.addWidget)
  const views = useStore((s) => s.views)
  const activeViewId = useStore((s) => s.activeViewId)

  if (!modalWidget) return null

  const WidgetComponent = widgetRegistry[modalWidget.type]
  if (!WidgetComponent) return null

  // Check if this widget type already exists in the current view
  const activeView = views.find((v) => v.id === activeViewId)
  const alreadyInView = activeView?.widgets.some((w) => w.type === modalWidget.type) ?? false

  function handleAddToView() {
    if (!modalWidget || alreadyInView) return
    addWidget(activeViewId, modalWidget.type)
    closeModalWidget()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-2 sm:p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-scrim backdrop-blur-sm"
        onClick={closeModalWidget}
      />

      {/* Modal */}
      <div className="relative w-full h-full max-w-5xl sm:max-h-[85vh] bg-surface border border-border rounded-xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Maximize2 size={14} className="text-accent" />
            <span className="text-sm font-semibold text-text">
              {WIDGET_LABELS[modalWidget.type]}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            {!alreadyInView && (
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-accent bg-accent/10 hover:bg-accent/20 rounded-lg transition-colors"
                onClick={handleAddToView}
                title="Add this widget to current view"
              >
                <Plus size={13} />
                Add to view
              </button>
            )}
            <button
              className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg hover:bg-overlay-3 transition-colors"
              onClick={closeModalWidget}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Widget content */}
        <div className="flex-1 overflow-hidden p-3">
          <WidgetComponent />
        </div>
      </div>
    </div>
  )
}
