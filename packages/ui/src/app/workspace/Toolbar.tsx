/**
 * Toolbar — workspace chrome: views, widgets, ops controls.
 *
 * View tabs are Poolside-style: active tab shares the elevated canvas plane
 * (`.workspace-stage`); logo stays left of the strip. Reorder is Chrome-like
 * (floating tab + in-flow placeholder gap — no peer pack/translate on grab).
 */

import { ChevronDown, GripVertical, LayoutGrid, Plus, X } from "lucide-react"
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react"
import type { Me } from "../../hooks/useMe"
import { useViewTabReorder } from "../../hooks/useViewTabReorder"
import { SessionMenu } from "../SessionMenu"
import { ViewingAsControl } from "../ViewingAsControl"
import { CHAT_BRAND_LOGO_SIZE } from "../brand"
import type { AppShellMode } from "../types"
import { useStore } from "../../state/store"
import { useLayoutStore } from "../../state/layout-store"
import { Logo } from "../../components/Logo"
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
    float,
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

  function renderTab(view: (typeof views)[number], isDragging: boolean): JSX.Element {
    const isActive = view.id === activeViewId
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
            <X size={14} />
          </button>
        )}
      </div>
    )
  }

  function stripTabs(): ReactNode {
    if (!draggingId || dropSlot == null) {
      return views.map((view) => renderTab(view, false))
    }
    const rest = views.filter((view) => view.id !== draggingId)
    const dragged = views.find((view) => view.id === draggingId)
    const nodes: ReactNode[] = []
    for (let i = 0; i <= rest.length; i++) {
      if (i === dropSlot) {
        nodes.push(
          <div
            key="__view-tab-slot"
            className="view-tab-slot"
            style={{ width: dragWidthPx }}
            aria-hidden
          />,
        )
      }
      if (i < rest.length) {
        nodes.push(renderTab(rest[i]!, false))
      }
    }
    // Capture host — out of flow; keeps pointer capture alive.
    if (dragged) nodes.push(renderTab(dragged, true))
    return nodes
  }

  return (
    <header className="toolbar-shell relative z-20 flex shrink-0 select-none items-end gap-2 px-1 pt-2 sm:gap-3">
      <div className="toolbar-brand mb-1.5 flex h-9 shrink-0 items-center self-center">
        <Logo size={CHAT_BRAND_LOGO_SIZE} online={connected} className="toolbar-brand-logo" />
      </div>

      <div
        ref={tabsRef}
        className="view-tab-strip flex min-w-0 flex-1 items-end overflow-x-auto scrollbar-none"
        {...(draggingId ? { "data-reordering": "" } : {})}
      >
        {stripTabs()}

        <button
          type="button"
          className="view-tab-add mb-1 ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-overlay-hover hover:text-text"
          onClick={() => addView(`View ${views.length + 1}`)}
          title="Add view"
        >
          <Plus size={16} />
        </button>

        {float && <ViewTabDragFloat float={float} />}
      </div>

      {tabsOverflow && (
        <div className="relative mb-1.5 shrink-0 self-center" ref={moreRef}>
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

      <div className="mb-1.5 flex shrink-0 items-center gap-1 self-center">
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
