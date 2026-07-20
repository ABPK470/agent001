/**
 * Toolbar — workspace shell: views, widgets, ops controls.
 */

import { ChevronDown, GripVertical, LayoutGrid, MessageSquare, Plus, X } from "lucide-react"
import { Fragment, useEffect, useRef, useState } from "react"
import type { Me } from "../../hooks/useMe"
import { useViewTabReorder } from "../../hooks/useViewTabReorder"
import { fullIndexFromRemainingSlot } from "../../lib/view-tab-dnd"
import { SessionMenu } from "../SessionMenu"
import { CHAT_BRAND_LOGO_SIZE } from "../brand"
import type { AppShellMode } from "../types"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import { Logo } from "../../components/Logo"
import { NotificationPanel } from "../../widgets/platform/NotificationPanel"
import { ViewTabDropMarker } from "./ViewTabDropMarker"

interface Props {
  onAddWidget?: () => void
  onSignOut: () => void
  onModeChange: (mode: AppShellMode) => void
  me?: Me | null
}

const ICON_BTN =
  "flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-text hover:bg-overlay-hover transition-colors"

export function Toolbar({ onAddWidget, onSignOut, onModeChange, me }: Props) {
  const connected = useStore((s) => s.connected)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const setActiveView = useLayoutStore((s) => s.setActiveView)
  const addView = useLayoutStore((s) => s.addView)
  const removeView = useLayoutStore((s) => s.removeView)
  const renameView = useLayoutStore((s) => s.renameView)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const tabsRef = useRef<HTMLDivElement>(null)
  const [tabsOverflow, setTabsOverflow] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const {
    draggingId,
    dropSlot,
    dragWidthPx,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
    onTabPointerCancel,
    onTabLostPointerCapture,
  } = useViewTabReorder(tabsRef, editing)

  useEffect(() => {
    if (!moreOpen) return
    function handleClick(event: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [moreOpen])

  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const check = () => setTabsOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [views.length])

  useEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(`[data-view-id="${activeViewId}"]`)
    el?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })
  }, [activeViewId])

  function handleDoubleClick(id: string, name: string) {
    setEditing(id)
    setEditName(name)
  }

  function handleRename(id: string) {
    if (editName.trim()) {
      renameView(id, editName.trim())
    }
    setEditing(null)
  }

  const dragView = draggingId ? views.find((v) => v.id === draggingId) : null
  const fromIndex = dragView ? views.findIndex((v) => v.id === dragView.id) : -1
  const ghostAt = dropSlot != null && fromIndex >= 0
    ? fullIndexFromRemainingSlot(fromIndex, dropSlot)
    : null

  return (
    <header className="toolbar-shell flex h-14 shrink-0 select-none items-center gap-2 px-4 sm:gap-4 sm:px-6 bg-canvas">
      <div className="toolbar-brand flex h-9 shrink-0 items-center">
        <Logo size={CHAT_BRAND_LOGO_SIZE} online={connected} className="toolbar-brand-logo" />
      </div>

      <div
        ref={tabsRef}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
      >
        {views.map((view, index) => {
          const isDragging = draggingId === view.id

          return (
            <Fragment key={view.id}>
              {ghostAt === index && dragView && (
                <ViewTabDropMarker name={dragView.name} widthPx={dragWidthPx} />
              )}
              <div
                data-view-id={view.id}
                {...(isDragging ? { "data-view-dragging": "" } : {})}
                className={[
                  "group relative flex h-9 shrink-0 cursor-grab items-center gap-1 rounded-lg px-2.5 text-[13px] transition-[width,padding,opacity,background-color] active:cursor-grabbing",
                  view.id === activeViewId
                    ? "font-semibold text-text"
                    : "text-text-muted hover:text-text-secondary",
                  draggingId && !isDragging ? "view-tab-peer-dim" : "",
                  isDragging ? "view-tab-dragging" : "",
                ].join(" ")}
                onPointerDown={(event) => onTabPointerDown(view.id, event)}
                onPointerMove={onTabPointerMove}
                onPointerUp={onTabPointerUp}
                onPointerCancel={onTabPointerCancel}
                onLostPointerCapture={onTabLostPointerCapture}
                onDoubleClick={() => handleDoubleClick(view.id, view.name)}
                title="Click to open · drag to reorder"
              >
                <GripVertical
                  size={12}
                  className="relative z-[2] shrink-0 text-text-faint opacity-0 transition-opacity group-hover:opacity-70"
                  aria-hidden
                />
                {editing === view.id ? (
                  <input
                    className="bg-transparent border-none outline-none text-[13px] text-text w-24"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={() => handleRename(view.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRename(view.id)
                      if (e.key === "Escape") setEditing(null)
                    }}
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="relative z-[2] whitespace-nowrap">{view.name}</span>
                )}
                {views.length > 1 && (
                  <button
                    type="button"
                    className="relative z-[2] ml-0.5 text-text-muted opacity-0 group-hover:opacity-60 hover:!opacity-100"
                    onClick={(e) => {
                      e.stopPropagation()
                      removeView(view.id)
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    title="Close view"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </Fragment>
          )
        })}
        {ghostAt === views.length && dragView && (
          <ViewTabDropMarker name={dragView.name} widthPx={dragWidthPx} />
        )}

        <button
          type="button"
          className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted transition-colors hover:text-text"
          onClick={() => addView(`View ${views.length + 1}`)}
          title="Add view"
        >
          <Plus size={16} />
        </button>
      </div>

      {tabsOverflow && (
        <div className="relative shrink-0" ref={moreRef}>
          <button
            type="button"
            className="flex items-center gap-1 h-9 px-2 text-[13px] text-text-muted hover:text-text hover:bg-overlay-hover rounded-lg transition-colors"
            onClick={() => setMoreOpen((value) => !value)}
            title="All views"
          >
            <span className="hidden sm:inline">More</span>
            <ChevronDown size={14} />
          </button>
          {moreOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-56 max-h-[60vh] overflow-y-auto bg-panel-2 border border-border rounded-xl shadow-xl shadow-black/40 py-1.5 z-50">
              {views.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={`flex items-center justify-between w-full px-4 py-2.5 text-sm transition-colors ${
                    view.id === activeViewId
                      ? "text-text font-semibold bg-overlay-hover"
                      : "text-text-secondary hover:text-text hover:bg-overlay-hover"
                  }`}
                  onClick={() => {
                    setActiveView(view.id)
                    setMoreOpen(false)
                  }}
                >
                  <span className="truncate">{view.name}</span>
                  {view.id === activeViewId && <span className="text-accent text-xs">●</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1">
        {onAddWidget && (
          <>
            <button
              type="button"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-text-muted transition-colors hover:bg-overlay-hover hover:text-text"
              onClick={onAddWidget}
              title="Add widget to this view"
            >
              <LayoutGrid size={15} />
              <span className="hidden sm:inline">Widget</span>
            </button>
            <div className="toolbar-shell-divider mx-1.5" aria-hidden />
          </>
        )}
        <NotificationPanel />
        <button
          type="button"
          onClick={() => onModeChange("chat")}
          title="Chat"
          aria-label="Open chat"
          className={ICON_BTN}
        >
          <MessageSquare size={15} />
        </button>
        {me && <SessionMenu me={me} onSignOut={onSignOut} />}
      </div>
    </header>
  )
}
