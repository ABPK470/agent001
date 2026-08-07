/**
 * WidgetModal — Summon peek stage (any widget as a floating overlay).
 * Must mount at the app root (sibling of Summon), never inside `.app-shell-slider`:
 * that track uses transform, which traps `position: fixed` to half the viewport.
 *
 * Peek is a temporary focused operator surface — same WidgetInstance + claim path
 * as a Space tile. Enter adds into the active Space when the surface does not
 * claim Enter; Esc closes the peek.
 */

import { Plus, X } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import {
  SetupHintChromeProvider,
  setupHintHeaderClass,
  useSetupHintChromeTone,
} from "../../components/SetupHintStrip"
import { isEditableKeyboardTarget } from "../../lib/keyboard-target"
import { peekWidgetInstanceId } from "../../lib/operator-surface-armed"
import { useLayoutStore } from "../../state/layout-store"
import { useStore } from "../../state/store"
import {
  MODAL_ENTITY_FOCUS_PANEL,
  MODAL_SURFACE_CLASS,
  modalOverlayClass,
} from "../../widgets/entity-registry/modal-overlay"
import { WidgetInstanceProvider } from "./widget-instance"
import { getWidgetDefinition } from "./widget-definitions"
import { wrapWidgetBody } from "./widget-shell-layout"

export function WidgetModal() {
  const modalWidget = useStore((s) => s.modalWidget)
  const closeModalWidget = useStore((s) => s.closeModalWidget)
  const addWidget = useLayoutStore((s) => s.addWidget)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const panelRef = useRef<HTMLDivElement | null>(null)

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

  const peekInstance = useMemo(() => {
    if (!modalWidget) return null
    return {
      widgetId: peekWidgetInstanceId(modalWidget.type),
      viewId: activeViewId,
      type: modalWidget.type,
    }
  }, [modalWidget, activeViewId])

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
      // Root (registered earlier) stopImmediatePropagates when the surface claims Enter.
      event.preventDefault()
      event.stopPropagation()
      handleAddToViewRef.current()
    }
    window.addEventListener("keydown", onPeekKeyDown, true)
    return () => window.removeEventListener("keydown", onPeekKeyDown, true)
  }, [modalWidget])

  // Land keyboard on the peeked surface (tree / scroll host), not Summon’s input.
  useEffect(() => {
    if (!modalWidget) return
    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current
      if (!panel) return
      const host = panel.querySelector<HTMLElement>(
        "[role='tree'], .trace-split-tree-scroll, .review-split-list-scroll, [tabindex='0']",
      )
      host?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [modalWidget])

  if (!modalWidget || !peekInstance) return null

  const definition = getWidgetDefinition(modalWidget.type)
  const WidgetComponent = definition.component
  const WidgetIcon = definition.icon

  return (
    <div
      className={modalOverlayClass("focus", { zIndexClass: "z-[420]" })}
      onClick={closeModalWidget}
    >
      <WidgetInstanceProvider value={peekInstance}>
        <SetupHintChromeProvider>
          <div
            ref={panelRef}
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
      </WidgetInstanceProvider>
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

      <div className="widget-controls flex items-center gap-0.5 shrink-0">
        {!alreadyInView && (
          <button
            type="button"
            className="toolbar-ops-btn shrink-0 px-2.5"
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
          className="toolbar-ops-btn toolbar-ops-btn--danger shrink-0"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close (Esc)"
        >
          <X size={14} aria-hidden />
        </button>
      </div>
    </div>
  )
}
