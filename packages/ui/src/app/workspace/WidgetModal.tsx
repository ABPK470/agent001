/**
 * WidgetModal — Summon peek stage (any widget as a floating overlay).
 * Must mount at the app root (sibling of Summon), never inside `.app-shell-slider`:
 * that track uses transform, which traps `position: fixed` to half the viewport.
 *
 * Enter adds the surface into the active Space (when not already present).
 * Esc closes the peek.
 */

import { Plus, X } from "lucide-react"
import { useEffect, useRef } from "react"
import {
  SetupHintChromeProvider,
  setupHintHeaderClass,
  useSetupHintChromeTone,
} from "../../components/SetupHintStrip"
import { isEditableKeyboardTarget } from "../../lib/keyboard-target"
import { useLayoutStore } from "../../state/layout-store"
import { useStore } from "../../state/store"
import {
  MODAL_ENTITY_FOCUS_PANEL,
  MODAL_SURFACE_CLASS,
  modalOverlayClass,
} from "../../widgets/entity-registry/modal-overlay"
import { getWidgetDefinition } from "./widget-definitions"
import { wrapWidgetBody } from "./widget-shell-layout"

export function WidgetModal() {
  const modalWidget = useStore((s) => s.modalWidget)
  const closeModalWidget = useStore((s) => s.closeModalWidget)
  const addWidget = useLayoutStore((s) => s.addWidget)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)

  const modalWidgetRef = useRef(modalWidget)
  const alreadyInViewRef = useRef(false)
  const activeViewIdRef = useRef(activeViewId)
  modalWidgetRef.current = modalWidget
  activeViewIdRef.current = activeViewId

  const activeView = views.find((view) => view.id === activeViewId)
  const alreadyInView =
    modalWidget != null
    && (activeView?.tiles.some((tile) => tile.type === modalWidget.type) ?? false)
  alreadyInViewRef.current = alreadyInView

  function handleAddToView() {
    const widget = modalWidgetRef.current
    if (!widget || alreadyInViewRef.current) return
    addWidget(activeViewIdRef.current, widget.type)
    closeModalWidget()
  }

  const handleAddToViewRef = useRef(handleAddToView)
  const closeModalWidgetRef = useRef(closeModalWidget)
  handleAddToViewRef.current = handleAddToView
  closeModalWidgetRef.current = closeModalWidget

  useEffect(() => {
    if (!modalWidget) return
    function onPeekKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        closeModalWidgetRef.current()
        return
      }
      if (event.key !== "Enter") return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (isEditableKeyboardTarget(event.target)) return
      if (alreadyInViewRef.current) return
      event.preventDefault()
      event.stopPropagation()
      handleAddToViewRef.current()
    }
    window.addEventListener("keydown", onPeekKeyDown, true)
    return () => window.removeEventListener("keydown", onPeekKeyDown, true)
  }, [modalWidget])

  if (!modalWidget) return null

  const definition = getWidgetDefinition(modalWidget.type)
  const WidgetComponent = definition.component
  const WidgetIcon = definition.icon

  return (
    <div
      className={modalOverlayClass("focus", { zIndexClass: "z-[420]" })}
      onClick={closeModalWidget}
    >
      <SetupHintChromeProvider>
        <div
          className={`${MODAL_SURFACE_CLASS} ${MODAL_ENTITY_FOCUS_PANEL} flex flex-col overflow-hidden`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="widget-view-container flex min-h-0 flex-1 flex-col overflow-hidden">
            <WidgetModalHeader
              label={definition.label}
              icon={<WidgetIcon size={16} className="text-text-muted" />}
              alreadyInView={alreadyInView}
              onAddToView={handleAddToView}
              onClose={closeModalWidget}
            />

            <div className="widget-content flex min-h-0 flex-1 flex-col overflow-hidden p-0">
              {wrapWidgetBody(definition.layout, <WidgetComponent />)}
            </div>
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
            className="widget-modal-add-btn"
            onClick={onAddToView}
            title="Add to Space (Enter)"
            aria-label="Add to Space (Enter)"
          >
            <Plus size={13} aria-hidden />
            <span>Add</span>
            <span className="catalog-shortcut-hint" aria-hidden>
              <kbd className="catalog-shortcut-hint__key catalog-shortcut-hint__key--char">
                <span className="catalog-shortcut-hint__key-glyph">↵</span>
              </kbd>
            </span>
          </button>
        )}
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg hover:bg-overlay-3 transition-colors"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close (Esc)"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
