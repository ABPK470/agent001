/**
 * WidgetModal — opens any widget as a floating modal overlay.
 */

import { Plus, X } from "lucide-react"
import {
  SetupHintChromeProvider,
  setupHintHeaderClass,
  useSetupHintChromeTone,
} from "../../components/SetupHintStrip"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import {
  MODAL_ENTITY_FOCUS_PANEL,
  MODAL_SURFACE_CLASS,
  modalOverlayClass,
} from "../../widgets/entity-registry/modal-overlay"
import { getWidgetDefinition } from "./widget-definitions"

export function WidgetModal() {
  const modalWidget = useStore((s) => s.modalWidget)
  const closeModalWidget = useStore((s) => s.closeModalWidget)
  const addWidget = useLayoutStore((s) => s.addWidget)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)

  if (!modalWidget) return null

  const definition = getWidgetDefinition(modalWidget.type)
  const WidgetComponent = definition.component
  const WidgetIcon = definition.icon

  const activeView = views.find((view) => view.id === activeViewId)
  const alreadyInView = activeView?.tiles.some((tile) => tile.type === modalWidget.type) ?? false

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
      <SetupHintChromeProvider>
        <div
          className={`${MODAL_SURFACE_CLASS} ${MODAL_ENTITY_FOCUS_PANEL} flex flex-col overflow-hidden`}
          onClick={(e) => e.stopPropagation()}
        >
          <WidgetModalHeader
            label={definition.label}
            icon={<WidgetIcon size={16} className="text-text-muted" />}
            alreadyInView={alreadyInView}
            onAddToView={handleAddToView}
            onClose={closeModalWidget}
          />

          <div
            className={`flex-1 overflow-hidden ${
              definition.chrome === "flush" ? "p-0" : "p-3"
            }`}
          >
            <WidgetComponent />
          </div>
        </div>
      </SetupHintChromeProvider>
    </div>
  )
}

function WidgetModalHeader({
  label,
  icon,
  alreadyInView,
  onAddToView,
  onClose,
}: {
  label: string
  icon: React.ReactNode
  alreadyInView: boolean
  onAddToView: () => void
  onClose: () => void
}) {
  const hintTone = useSetupHintChromeTone()
  const hintWash = setupHintHeaderClass(hintTone)
  const borderClass = hintTone ? "border-b border-transparent" : "border-b border-border"

  return (
    <div className={`flex items-center justify-between px-4 h-12 shrink-0 ${borderClass} ${hintWash}`}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-sm font-semibold text-text">{label}</span>
      </div>

      <div className="flex items-center gap-1.5">
        {!alreadyInView && (
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] text-accent bg-accent/10 hover:bg-accent/20 rounded-lg transition-colors"
            onClick={onAddToView}
            title="Add this widget to current view"
          >
            <Plus size={13} />
            Add to view
          </button>
        )}
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg hover:bg-overlay-3 transition-colors"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
