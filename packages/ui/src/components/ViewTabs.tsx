/**
 * ViewTabs — tab bar for multiple dashboard views.
 *
 * Each tab is an independent canvas with its own widget layout.
 * Users can add, rename, and remove views.
 * Also hosts the "Add Widget" button, pinned to the right.
 */

import { LayoutGrid, Plus, X } from "lucide-react"
import { useState } from "react"
import { useStore } from "../store"

interface Props {
  onAddWidget: () => void
}

export function ViewTabs({ onAddWidget }: Props) {
  const views = useStore((s) => s.views)
  const activeViewId = useStore((s) => s.activeViewId)
  const setActiveView = useStore((s) => s.setActiveView)
  const addView = useStore((s) => s.addView)
  const removeView = useStore((s) => s.removeView)
  const renameView = useStore((s) => s.renameView)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")

  const activeView = views.find((v) => v.id === activeViewId)
  const hasWidgets = (activeView?.widgets.length ?? 0) > 0

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
      {/* Left: tabs (scrollable when too many) */}
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto px-3">
        {views.map((view) => (
          <div
            key={view.id}
            className={`
              group flex items-center gap-1.5 px-3 h-9 text-[13px] cursor-pointer shrink-0
              transition-colors
              ${view.id === activeViewId
                ? "text-white font-semibold"
                : "text-text-muted hover:text-text-secondary"
              }
            `}
            onClick={() => setActiveView(view.id)}
            onDoubleClick={() => handleDoubleClick(view.id, view.name)}
          >
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
              />
            ) : (
              <span className="whitespace-nowrap">{view.name}</span>
            )}
            {views.length > 1 && (
              <button
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-text-muted ml-0.5"
                onClick={(e) => { e.stopPropagation(); removeView(view.id) }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}

        <button
          className="flex items-center justify-center w-7 h-7 ml-1 shrink-0 text-text-muted hover:text-text rounded transition-colors"
          onClick={() => addView(`View ${views.length + 1}`)}
          title="Add view"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Right: Add Widget — only when canvas already has widgets */}
      {hasWidgets && (
        <button
          className="flex items-center gap-1.5 px-3 mr-2 shrink-0 text-text-muted hover:text-text-secondary text-[13px] transition-colors"
          onClick={onAddWidget}
        >
          <LayoutGrid size={14} />
          <span className="hidden sm:inline whitespace-nowrap">Add Widget</span>
        </button>
      )}
    </div>
  )
}
