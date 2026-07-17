/**
 * ViewTabs — tab bar for multiple dashboard views.
 */

import { GripVertical, Plus, X } from "lucide-react"
import { useRef, useState } from "react"
import { useViewTabReorder } from "../../hooks/useViewTabReorder"
import { useLayoutStore } from "../../state/layout-store"

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
    dropIndex,
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
      <div ref={tabsRef} className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto px-3">
        {views.map((view, index) => {
          const isDragging = draggingId === view.id
          const fromIndex = draggingId
            ? views.findIndex((item) => item.id === draggingId)
            : -1
          const showDropBefore = draggingId != null
            && dropIndex === index
            && draggingId !== view.id
            && fromIndex > index
          const showDropAfter = draggingId != null
            && dropIndex === index
            && draggingId !== view.id
            && fromIndex < index

          return (
            <div
              key={view.id}
              data-view-id={view.id}
              className={`
                group relative flex items-center gap-1 px-2.5 h-9 text-[13px] shrink-0
                transition-colors cursor-grab active:cursor-grabbing
                ${view.id === activeViewId
                  ? "text-text font-semibold"
                  : "text-text-muted hover:text-text-secondary"
                }
                ${isDragging ? "opacity-45" : ""}
              `}
              onPointerDown={(event) => onTabPointerDown(view.id, event)}
              onPointerMove={onTabPointerMove}
              onPointerUp={onTabPointerUp}
              onDoubleClick={() => handleDoubleClick(view.id, view.name)}
              title="Drag to reorder"
            >
              {showDropBefore && (
                <span className="pointer-events-none absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />
              )}
              <GripVertical
                size={12}
                className="shrink-0 text-text-faint opacity-0 group-hover:opacity-70 transition-opacity"
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
              {showDropAfter && (
                <span className="pointer-events-none absolute right-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-accent" />
              )}
            </div>
          )
        })}

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
