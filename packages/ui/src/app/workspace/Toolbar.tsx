/**
 * Toolbar — top rail of the workspace paper sheet.
 *
 * Brand + views + ops share one header band (same geometry tokens as chat).
 * The rail sits on the sheet — not floating above a separate card.
 * Sheet / Tab toggles are R&D surface knobs only.
 */

import { Bookmark, ChevronDown, GripVertical, LayoutGrid, PanelTop, Plus, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Me } from "../../hooks/useMe"
import { useViewTabReorder } from "../../hooks/useViewTabReorder"
import { peerSlidePx } from "../../lib/view-tab-dnd"
import { ChatBrand } from "../ChatBrand"
import { SessionMenu } from "../SessionMenu"
import { ViewingAsControl } from "../ViewingAsControl"
import { SHELL_CHROME_HEADER_WORKSPACE_CLASS } from "../shell-chrome"
import type { AppShellMode } from "../types"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import { NotificationPanel } from "../../widgets/platform/NotificationPanel"
import { ViewTabDragFloat } from "./ViewTabDragFloat"

interface Props {
  onAddWidget?: () => void
  onSignOut: () => void
  onModeChange: (mode: AppShellMode) => void
  me?: Me | null
}

export function Toolbar({ onAddWidget, onSignOut, onModeChange, me }: Props) {
  const connected = useStore((s) => s.connected)
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const setActiveView = useLayoutStore((s) => s.setActiveView)
  const addView = useLayoutStore((s) => s.addView)
  const removeView = useLayoutStore((s) => s.removeView)
  const renameView = useLayoutStore((s) => s.renameView)
  const workspaceSurface = useLayoutStore((s) => s.workspaceSurface)
  const setWorkspaceSurface = useLayoutStore((s) => s.setWorkspaceSurface)
  const activeTabLift = useLayoutStore((s) => s.activeTabLift)
  const setActiveTabLift = useLayoutStore((s) => s.setActiveTabLift)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const tabsRef = useRef<HTMLDivElement>(null)
  const [tabsOverflow, setTabsOverflow] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)
  const {
    draggingId,
    homeSlot,
    dropSlot,
    dragWidthPx,
    gapPx,
    float,
    slideAnimated,
    pointerSession,
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
    // Select-on-grab / drag must not scroll the strip — that shifts peers and `+`.
    if (draggingId || pointerSession) return
    const el = tabsRef.current?.querySelector<HTMLElement>(`[data-view-id="${activeViewId}"]`)
    el?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" })
  }, [activeViewId, draggingId, pointerSession])

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

  return (
    <header className={SHELL_CHROME_HEADER_WORKSPACE_CLASS}>
      <ChatBrand connected={connected} />

      <div
        ref={tabsRef}
        className="view-tab-strip flex min-w-0 flex-1 overflow-x-auto scrollbar-none"
        {...(draggingId
          ? {
              "data-reordering": "",
              ...(slideAnimated ? { "data-reorder-animate": "" } : {}),
            }
          : {})}
      >
        {views.map((view, fullIndex) => {
          const isDragging = draggingId === view.id
          const isActive = view.id === activeViewId
          const slide = !isDragging && draggingId && dropSlot != null
            ? peerSlidePx(fullIndex, homeSlot, dropSlot, dragWidthPx, gapPx)
            : 0

          return (
            <div
              key={view.id}
              data-view-id={view.id}
              {...(isDragging ? { "data-view-dragging": "" } : {})}
              className={[
                "view-tab group",
                isActive ? "view-tab--active" : "view-tab--inactive",
                draggingId && !isDragging ? "view-tab-peer-dim" : "",
                isDragging ? "view-tab-dragging" : "",
              ].join(" ")}
              style={
                draggingId && !isDragging
                  ? { transform: `translate3d(${slide}px,0,0)` }
                  : undefined
              }
              onPointerDown={(event) => onTabPointerDown(view.id, event)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerUp}
              onPointerCancel={onTabPointerCancel}
              onLostPointerCapture={onTabLostPointerCapture}
              onDoubleClick={() => handleDoubleClick(view.id, view.name)}
              onAuxClick={(event) => {
                if (event.button !== 1 || views.length <= 1) return
                event.preventDefault()
                event.stopPropagation()
                removeView(view.id)
              }}
              title={
                views.length > 1
                  ? "Click to open · middle-click to close · drag the grip to reorder"
                  : "Click to open · drag the grip to reorder"
              }
            >
              <GripVertical
                size={12}
                className="view-tab__grip relative z-[2] shrink-0"
                aria-hidden
              />
              {editing === view.id ? (
                <input
                  className="relative z-[2] w-24 border-none bg-transparent text-[13px] text-text outline-none"
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
                <span className="view-tab__label relative z-[2] whitespace-nowrap">{view.name}</span>
              )}
              {views.length > 1 && (
                <button
                  type="button"
                  className="view-tab__close relative z-[2]"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeView(view.id)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  title="Close view"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          )
        })}

        <button
          type="button"
          className="view-tab-add ml-0.5 flex shrink-0 items-center justify-center text-text-muted transition-colors hover:bg-overlay-hover hover:text-text"
          onClick={() => addView(`View ${views.length + 1}`)}
          title="Add view"
        >
          <Plus size={16} />
        </button>

        {float && <ViewTabDragFloat float={float} />}
      </div>

      {tabsOverflow && (
        <div className="relative shrink-0" ref={moreRef}>
          <button
            type="button"
            className="flex h-9 items-center gap-1 rounded-lg px-2 text-[13px] text-text-muted transition-colors hover:bg-overlay-hover hover:text-text"
            onClick={() => setMoreOpen((value) => !value)}
            title="All views"
          >
            <span className="hidden sm:inline">More</span>
            <ChevronDown size={14} />
          </button>
          {moreOpen && (
            <div className="absolute right-0 top-full z-50 mt-1.5 max-h-[60vh] w-56 overflow-y-auto rounded-xl border border-border bg-panel-2 py-1.5 shadow-xl shadow-black/40">
              {views.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  className={`flex w-full items-center justify-between px-4 py-2.5 text-sm transition-colors ${
                    view.id === activeViewId
                      ? "bg-overlay-hover font-semibold text-text"
                      : "text-text-secondary hover:bg-overlay-hover hover:text-text"
                  }`}
                  onClick={() => {
                    setActiveView(view.id)
                    setMoreOpen(false)
                  }}
                >
                  <span className="truncate">{view.name}</span>
                  {view.id === activeViewId && <span className="text-xs text-accent">●</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center gap-1">
        {onAddWidget && (
          <>
            <button
              type="button"
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] leading-none text-text-muted transition-colors hover:bg-overlay-hover hover:text-text"
              onClick={onAddWidget}
              title="Add widget to this view"
            >
              <LayoutGrid size={15} className="block shrink-0" aria-hidden />
              <span className="hidden leading-none sm:inline">Widget</span>
            </button>
            <button
              type="button"
              aria-pressed={workspaceSurface === "contrast"}
              className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] leading-none transition-colors ${
                workspaceSurface === "contrast"
                  ? "bg-overlay-2 text-text"
                  : "text-text-muted hover:bg-overlay-hover hover:text-text"
              }`}
              onClick={() =>
                setWorkspaceSurface(workspaceSurface === "contrast" ? "default" : "contrast")
              }
              title={
                workspaceSurface === "contrast"
                  ? "Default sheet: white paper lifted on the page"
                  : "Contrast sheet: warmer flat paper, stronger edge"
              }
            >
              <PanelTop size={15} className="block shrink-0" aria-hidden />
              <span className="hidden leading-none sm:inline">Sheet</span>
            </button>
            <button
              type="button"
              aria-pressed={activeTabLift}
              className={`flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[13px] leading-none transition-colors ${
                activeTabLift
                  ? "bg-overlay-2 text-text"
                  : "text-text-muted hover:bg-overlay-hover hover:text-text"
              }`}
              onClick={() => setActiveTabLift(!activeTabLift)}
              title={
                activeTabLift
                  ? "Selected view uses the default segment"
                  : "Lift selected view segment (stronger chip)"
              }
            >
              <Bookmark size={15} className="block shrink-0" aria-hidden />
              <span className="hidden leading-none sm:inline">Tab</span>
            </button>
            <div className="toolbar-shell-divider mx-1.5" aria-hidden />
          </>
        )}
        <NotificationPanel />
        <ViewingAsControl />
        {me && (
          <SessionMenu
            me={me}
            onSignOut={onSignOut}
            onOpenChat={() => onModeChange("chat")}
          />
        )}
      </div>
    </header>
  )
}
