/**
 * ViewTabs — tab bar for multiple dashboard views.
 *
 * Each tab is an independent canvas with its own widget layout.
 * Users can add, rename, and remove views.
 */

import { useState } from "react"
import { useStore } from "../store"

export function ViewTabs() {
  const views = useStore((s) => s.views)
  const activeViewId = useStore((s) => s.activeViewId)
  const setActiveView = useStore((s) => s.setActiveView)
  const addView = useStore((s) => s.addView)
  const removeView = useStore((s) => s.removeView)
  const renameView = useStore((s) => s.renameView)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")

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
    <div className="flex items-center h-8 px-2 border-b border-border shrink-0 select-none gap-0.5">
      {views.map((view) => (
        <div
          key={view.id}
          className={`
            group flex items-center gap-1 px-3 h-full text-[11px] cursor-pointer
            border-b-2 transition-colors
            ${view.id === activeViewId
              ? "border-accent text-text"
              : "border-transparent text-text-muted hover:text-text-secondary"
            }
          `}
          onClick={() => setActiveView(view.id)}
          onDoubleClick={() => handleDoubleClick(view.id, view.name)}
        >
          {editing === view.id ? (
            <input
              className="bg-transparent border-none outline-none text-[11px] text-text w-20"
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
            <span>{view.name}</span>
          )}
          {views.length > 1 && (
            <button
              className="opacity-0 group-hover:opacity-60 hover:!opacity-100 text-text-muted ml-1 text-[10px]"
              onClick={(e) => { e.stopPropagation(); removeView(view.id) }}
            >
              ×
            </button>
          )}
        </div>
      ))}

      <button
        className="flex items-center justify-center w-6 h-6 ml-1 text-text-muted hover:text-text rounded transition-colors text-sm"
        onClick={() => addView(`View ${views.length + 1}`)}
        title="Add view"
      >
        +
      </button>
    </div>
  )
}
