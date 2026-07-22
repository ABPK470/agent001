/**
 * WidgetShell — container chrome for dashboard tiles, modals, and pop-outs.
 */

import { ExternalLink, GripVertical, Maximize2, Minimize2, Pin, PinOff, X } from "lucide-react"
import { type ReactNode } from "react"
import {
  SetupHintChromeProvider,
  setupHintHeaderClass,
  useSetupHintChromeTone,
} from "../../components/SetupHintStrip"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import type { WidgetType } from "../../types"
import type { EdgePin } from "../../lib/grid-math"
import { getWidgetDefinition } from "./widget-definitions"

type ShellMode = "tile" | "modal" | "popout"

const EDGE_PIN_LABEL: Record<EdgePin, string> = {
  w: "left",
  e: "right",
  n: "top",
  s: "bottom",
}

interface Props {
  widgetId: string
  viewId: string
  type: WidgetType
  mode?: ShellMode
  pinned?: boolean
  /** Canvas edge glue from drag snap (`w`/`e`/`n`/`s`). */
  edgePin?: EdgePin
  maximized?: boolean
  onClose?: () => void
  onDragPointerDown?: (event: React.PointerEvent) => void
  children: ReactNode
}

function stopChromePointer(event: React.SyntheticEvent) {
  event.stopPropagation()
}

export function WidgetShell({
  widgetId,
  viewId,
  type,
  mode = "tile",
  pinned = false,
  edgePin,
  maximized = false,
  onClose,
  onDragPointerDown,
  children,
}: Props) {
  const removeWidget = useLayoutStore((s) => s.removeWidget)
  const setTilePinned = useLayoutStore((s) => s.setTilePinned)
  const toggleTileMaximized = useLayoutStore((s) => s.toggleTileMaximized)
  const definition = getWidgetDefinition(type)
  const chrome = definition.chrome

  function handlePopOut(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation()
    const state = useStore.getState()
    const params = new URLSearchParams()
    params.set("type", type)
    if (state.activeRunId) params.set("runId", state.activeRunId)

    try {
      localStorage.setItem("mia-popout-state", JSON.stringify({
        logs: state.logs,
        steps: state.steps,
        audit: state.audit,
        trace: state.trace,
        activeRunId: state.activeRunId,
      }))
    } catch { /* quota exceeded */ }

    const sourceEl = event.currentTarget.closest(".workspace-tile") as HTMLElement | null
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

  function handleClose(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (onClose) {
      onClose()
      return
    }
    removeWidget(viewId, widgetId)
  }

  function handleTogglePin(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    setTilePinned(viewId, widgetId, !pinned)
  }

  function handleToggleMaximize(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    toggleTileMaximized(viewId, widgetId)
  }

  const showChrome = mode !== "popout"
  const showDragHandle = mode === "tile" && !pinned && !maximized

  return (
    <SetupHintChromeProvider>
      <div className="workspace-shell flex flex-col h-full rounded-xl overflow-hidden bg-panel">
        {showChrome && (
          <WidgetShellHeader
            label={definition.label}
            mode={mode}
            pinned={pinned}
            edgePin={edgePin}
            maximized={maximized}
            showDragHandle={showDragHandle}
            onDragPointerDown={onDragPointerDown}
            onTogglePin={handleTogglePin}
            onToggleMaximize={handleToggleMaximize}
            onPopOut={handlePopOut}
            onClose={handleClose}
          />
        )}

        <div
          className={`widget-content flex flex-1 flex-col overflow-hidden ${
            chrome === "flush" ? "p-0" : chrome === "transparent" ? "p-0" : "p-3"
          }`}
        >
          {children}
        </div>
      </div>
    </SetupHintChromeProvider>
  )
}

function WidgetShellHeader({
  label,
  mode,
  pinned,
  edgePin,
  maximized,
  showDragHandle,
  onDragPointerDown,
  onTogglePin,
  onToggleMaximize,
  onPopOut,
  onClose,
}: {
  label: string
  mode: ShellMode
  pinned: boolean
  edgePin?: EdgePin
  maximized: boolean
  showDragHandle: boolean
  onDragPointerDown?: (event: React.PointerEvent) => void
  onTogglePin: (event: React.MouseEvent<HTMLButtonElement>) => void
  onToggleMaximize: (event: React.MouseEvent<HTMLButtonElement>) => void
  onPopOut: (event: React.MouseEvent<HTMLButtonElement>) => void
  onClose: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  const hintTone = useSetupHintChromeTone()
  const hintWash = setupHintHeaderClass(hintTone)

  return (
    <div
      className={`widget-drag-handle group flex items-center gap-1.5 px-2.5 h-9 shrink-0 select-none ${hintWash} ${
        showDragHandle ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      }`}
      onPointerDown={showDragHandle ? onDragPointerDown : undefined}
    >
      {mode === "tile" && (
        <span
          className={`text-text-faint shrink-0 ${showDragHandle ? "" : "opacity-40"}`}
          aria-hidden
        >
          <GripVertical size={16} />
        </span>
      )}
      <span className="text-xs font-medium text-text-muted uppercase tracking-wider truncate min-w-0 flex-1">
        {label}
        {pinned && !maximized && (
          <span className="ml-1.5 normal-case tracking-normal text-text-faint">(pinned)</span>
        )}
        {edgePin && !maximized && !pinned && (
          <span className="ml-1.5 normal-case tracking-normal text-text-faint">
            ({EDGE_PIN_LABEL[edgePin]})
          </span>
        )}
      </span>
      <div
        className="widget-controls flex items-center gap-0.5 shrink-0"
        onPointerDown={stopChromePointer}
        onMouseDown={stopChromePointer}
      >
        {mode === "tile" && (
          <>
            <button
              type="button"
              className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg transition-colors"
              onClick={onTogglePin}
              title={pinned ? "Unpin" : "Pin"}
              aria-label={pinned ? "Unpin widget" : "Pin widget"}
            >
              {pinned ? <PinOff size={16} /> : <Pin size={16} />}
            </button>
            <button
              type="button"
              className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg transition-colors"
              onClick={onToggleMaximize}
              title={maximized ? "Restore" : "Maximize"}
              aria-label={maximized ? "Restore widget" : "Maximize widget"}
            >
              {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button
              type="button"
              className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-text rounded-lg transition-colors"
              onClick={onPopOut}
              title="Pop out"
              aria-label="Pop out widget"
            >
              <ExternalLink size={16} />
            </button>
          </>
        )}
        <button
          type="button"
          className="flex items-center justify-center w-8 h-8 text-text-muted hover:text-error rounded-lg transition-colors"
          onClick={onClose}
          title="Close"
          aria-label="Close widget"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
