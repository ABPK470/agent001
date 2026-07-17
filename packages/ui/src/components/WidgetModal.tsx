/**
 * WidgetModal — opens any widget as a floating modal overlay.
 *
 * Used when a notification action points to a widget that isn't
 * in the current view. The modal shows the widget with full
 * functionality plus an "Add to view" button to embed it.
 */

import { Plus, X } from "lucide-react"
import { useStore } from "../store"
import type { WidgetType } from "../types"
import {
  MODAL_ENTITY_FOCUS_PANEL,
  MODAL_SURFACE_CLASS,
  modalOverlayClass,
} from "../widgets/entity-registry/modal-overlay"
import { widgetRegistry } from "../widgets"
import { WIDGET_ICONS } from "../widgets/widget-icons"

const WIDGET_LABELS: Record<WidgetType, string> = {
  "thread-nav": "Threads",
  "agent-chat": "Agent Chat",
  "term-chat": "Chat",
  "run-status": "Run Status",
  "live-logs": "Event Stream",
  "step-timeline": "Step Timeline",
  "run-history": "Run History",
  "debug-inspector": "Trace",
  "mymi-db": "MyMI Database",
  "active-users": "Active Users",
  "env-sync": "Sync",
  "operation-log": "Pipelines",
  "entity-registry": "Entity Registry",
  "sync-proposals": "Sync Proposals",
  "sync-approvals": "Sync Admin · Approvals",
  "sync-evidence":  "Sync Evidence",
  "sync-admin":     "Sync Admin",
  "bridge": "Bridge",
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

  const WidgetIcon = WIDGET_ICONS[modalWidget.type]

  // Check if this widget type already exists in the current view
  const activeView = views.find((v) => v.id === activeViewId)
  const alreadyInView = activeView?.widgets.some((w) => w.type === modalWidget.type) ?? false

  function handleAddToView() {
    if (!modalWidget || alreadyInView) return
    addWidget(activeViewId, modalWidget.type)
    closeModalWidget()
  }

  return (
    <div
      className={modalOverlayClass("focus", { zIndexClass: "z-[200]" })}
      onClick={closeModalWidget}
    >
      <div
        className={`${MODAL_SURFACE_CLASS} ${MODAL_ENTITY_FOCUS_PANEL} flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <WidgetIcon size={16} className="text-text-muted" />
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
        <div
          className={`flex-1 overflow-hidden ${
            modalWidget.type === "entity-registry"
            || modalWidget.type === "sync-admin"
            || modalWidget.type === "bridge"
            || modalWidget.type.startsWith("sync-")
              ? "p-0"
              : "p-3"
          }`}
        >
          <WidgetComponent />
        </div>
      </div>
    </div>
  )
}
