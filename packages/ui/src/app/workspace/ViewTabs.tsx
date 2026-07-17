/**
 * ViewTabs — tab bar for multiple dashboard views.
 */

import { GripVertical, Plus, X } from "lucide-react"
import { useRef, useState } from "react"
import { useViewTabReorder } from "../../hooks/useViewTabReorder"
import { useLayoutStore } from "../../state/layout-store"
import { ViewTabDropMarker } from "./ViewTabDropMarker"

interface Props {
  onAddWidget: () => void
}

export function ViewTabs({ onAddWidget: _onAddWidget }: Props) {
  const views = useLayoutStore((s) => s.views)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const addView = useLayoutStore((s) => s.addView)
  const removeView = useLayoutStore((s) => s.removeView)
  const renameView = useLayoutStore((s) => s.renameView)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const tabsRef = useRef<HTMLDivElement>(null)
  const {
    draggingId,
    dropSlot,
    onTabPointerDown,
    onTabPointerMove,
    onTabPointerUp,
  } = useViewTabReorder(tabsRef, editing)

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
    <div className="flex items-center h-9 bg-base shrink-0 select-none">
      <div
        ref={tabsRef}
        className={`flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-3 ${
          draggingId ? "rounded-lg bg-elevated/40" : ""
        }`}
      >
        {views.map((view, index) => {
          const isDragging = draggingId === view.id
          const showMarker = dropSlot === index

          return (
            <div key={view.id} className="relative flex shrink-0 items-center">
              {showMarker && <ViewTabDropMarker edge="before" />}
              <div
                data-view-id={view.id}
                className={`
                  group relative flex h-9 items-center gap-1 px-2.5 text-[13px] shrink-0
                  rounded-lg transition-[opacity,transform,box-shadow,background-color] cursor-grab active:cursor-grabbing
                  ${view.id === activeViewId
                    ? "text-text font-semibold"
                    : "text-text-muted hover:text-text-secondary"
                  }
                  ${draggingId && !isDragging ? "opacity-55" : ""}
                  ${isDragging
                    ? "z-10 scale-[1.03] bg-panel-2 text-text opacity-100 shadow-md ring-2 ring-accent/70"
                    : ""
                  }
                `}
                onPointerDown={(event) => onTabPointerDown(view.id, event)}
                onPointerMove={onTabPointerMove}
                onPointerUp={onTabPointerUp}
                onDoubleClick={() => handleDoubleClick(view.id, view.name)}
                title="Drag to reorder"
              >
                <GripVertical
                  size={12}
                  className={`shrink-0 transition-opacity ${
                    isDragging || draggingId
                      ? "text-accent opacity-100"
                      : "text-text-faint opacity-0 group-hover:opacity-70"
                  }`}
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
                  <span className="whitespace-nowrap">{view.name}</span>
                )}
                {views.length > 1 && (
                  <button
                    type="button"
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-text-muted ml-0.5"
                    onClick={(e) => { e.stopPropagation(); removeView(view.id) }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {dropSlot === views.length && (
          <div className="relative h-9 w-0 shrink-0">
            <ViewTabDropMarker edge="after" />
          </div>
        )}

        <button
          type="button"
          className="flex items-center justify-center w-7 h-7 ml-1 shrink-0 text-text-muted hover:text-text rounded transition-colors"
          onClick={() => addView(`View ${views.length + 1}`)}
          title="Add view"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  )
}
