/**
 * WidgetShell — container chrome for layout tiles, modals, and pop-outs.
 *
 * Every widget shares one card-shell dialect:
 * canvas viewport → unboxed title → bordered panel (or split grid).
 */

import { ExternalLink, Expand, GripVertical, Maximize2, Minimize2, Pin, PinOff, X } from "lucide-react"
import { type ReactNode } from "react"
import {
  SetupHintChromeProvider,
  useSetupHintChromeTone,
} from "../../components/SetupHintStrip"
import type { EdgePin } from "../../lib/grid-math"
import { useLayoutStore } from "../../state/layout-store"
import { useStore } from "../../state/store"
import type { WidgetType } from "../../types"
import { captureSoloFlipForTileId } from "./layout/solo-flip"
import { getWidgetDefinition } from "./widget-definitions"
import { wrapWidgetBody } from "./widget-shell-layout"
import { WidgetInstanceProvider } from "./widget-instance"
import { widgetSupportsFocusMode } from "../../lib/widget-focus"

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
  zen?: boolean
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
  zen = false,
  onClose,
  onDragPointerDown,
  children,
}: Props) {
  const removeWidget = useLayoutStore((s) => s.removeWidget)
  const setTilePinned = useLayoutStore((s) => s.setTilePinned)
  const toggleTileMaximized = useLayoutStore((s) => s.toggleTileMaximized)
  const toggleTileZen = useLayoutStore((s) => s.toggleTileZen)
  const definition = getWidgetDefinition(type)
  const layout = definition.layout
  const supportsFocus = widgetSupportsFocusMode(type)

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
    } catch (err: unknown) { console.error("[mia]", err) }

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
    captureSoloFlipForTileId(widgetId)
    toggleTileMaximized(viewId, widgetId)
  }

  function handleToggleZen(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (zen) {
      useLayoutStore.getState().exitTileZen()
      return
    }
    captureSoloFlipForTileId(widgetId)
    toggleTileZen(viewId, widgetId)
  }

  const showChrome = mode !== "popout" && !zen
  const showDragHandle = mode === "tile" && !pinned && !maximized && !zen

  const header = showChrome ? (
    <WidgetShellHeader
      label={definition.label}
      mode={mode}
      pinned={pinned}
      edgePin={edgePin}
      maximized={maximized}
      zen={zen}
      supportsFocus={supportsFocus}
      showDragHandle={showDragHandle}
      onDragPointerDown={onDragPointerDown}
      onTogglePin={handleTogglePin}
      onToggleMaximize={handleToggleMaximize}
      onToggleZen={handleToggleZen}
      onPopOut={handlePopOut}
      onClose={handleClose}
    />
  ) : null

  return (
    <WidgetInstanceProvider value={{ widgetId, viewId, type }}>
    <SetupHintChromeProvider>
      <div className={`workspace-shell workspace-shell--card-view${zen ? " workspace-shell--zen" : ""} flex h-full flex-col overflow-hidden`}>
        <div className="widget-view-container flex min-h-0 flex-1 flex-col overflow-hidden">
          {header}
          <div className="widget-content flex min-h-0 flex-1 flex-col overflow-hidden p-0">
            {wrapWidgetBody(layout, children)}
          </div>
        </div>
      </div>
    </SetupHintChromeProvider>
    </WidgetInstanceProvider>
  )
}

function WidgetShellHeader({
  label,
  mode,
  pinned,
  edgePin,
  maximized,
  zen,
  supportsFocus,
  showDragHandle,
  onDragPointerDown,
  onTogglePin,
  onToggleMaximize,
  onToggleZen,
  onPopOut,
  onClose,
}: {
  label: string
  mode: ShellMode
  pinned: boolean
  edgePin?: EdgePin
  maximized: boolean
  zen: boolean
  supportsFocus: boolean
  showDragHandle: boolean
  onDragPointerDown?: (event: React.PointerEvent) => void
  onTogglePin: (event: React.MouseEvent<HTMLButtonElement>) => void
  onToggleMaximize: (event: React.MouseEvent<HTMLButtonElement>) => void
  onToggleZen: (event: React.MouseEvent<HTMLButtonElement>) => void
  onPopOut: (event: React.MouseEvent<HTMLButtonElement>) => void
  onClose: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  useSetupHintChromeTone()

  return (
    <div
      className={[
        "widget-drag-handle widget-shell-header--flush group flex h-9 shrink-0 select-none items-center gap-1.5 px-1",
        showDragHandle ? "cursor-grab active:cursor-grabbing" : "cursor-default",
      ].join(" ")}
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
      <span
        className={[
          "truncate min-w-0 flex-1 tracking-normal text-[13px] font-medium text-text-secondary",
          maximized ? "!text-[14px] !font-semibold !text-text" : "",
        ].join(" ")}
      >
        {label}
        {pinned && !maximized && (
          <span className="ml-1.5 font-normal text-text-faint">(pinned)</span>
        )}
        {edgePin && !maximized && !pinned && (
          <span className="ml-1.5 font-normal text-text-faint">
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
              className="widget-shell-icon"
              onClick={onTogglePin}
              title={pinned ? "Unpin" : "Pin"}
              aria-label={pinned ? "Unpin" : "Pin"}
            >
              {pinned ? <PinOff size={16} /> : <Pin size={16} />}
            </button>
            <button
              type="button"
              className="widget-shell-icon"
              onClick={onToggleMaximize}
              title={maximized ? "Restore" : "Maximize"}
              aria-label={maximized ? "Restore" : "Maximize"}
            >
              {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            {supportsFocus ? (
              <button
                type="button"
                className={`widget-shell-icon${zen ? " is-active" : ""}`}
                onClick={onToggleZen}
                title={zen ? "Exit focus (Z)" : "Focus mode (Z)"}
                aria-label={zen ? "Exit focus mode" : "Enter focus mode"}
                aria-pressed={zen}
              >
                <Expand size={16} />
              </button>
            ) : null}
            <button
              type="button"
              className="widget-shell-icon"
              onClick={onPopOut}
              title="Pop out"
              aria-label="Pop out"
            >
              <ExternalLink size={16} />
            </button>
          </>
        )}
        <button
          type="button"
          className="widget-shell-icon widget-shell-icon--danger"
          onClick={onClose}
          title="Close"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
