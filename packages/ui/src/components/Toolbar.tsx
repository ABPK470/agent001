/**
 * Toolbar — top bar with branding, view tabs, menu dropdown, and widget button.
 */

import { Activity, Bot, LayoutGrid, Menu, Plus, Shield, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { useStore } from "../store"
import { AgentEditor } from "./AgentEditor"
import { Logo } from "./Logo"
import { NotificationPanel } from "./NotificationPanel"
import { PolicyEditor } from "./PolicyEditor"
import { UsageModal } from "./UsageModal"

interface Props {
  onAddWidget?: () => void
}

export function Toolbar({ onAddWidget }: Props) {
  const connected = useStore((s) => s.connected)
  const views = useStore((s) => s.views)
  const activeViewId = useStore((s) => s.activeViewId)
  const setActiveView = useStore((s) => s.setActiveView)
  const addView = useStore((s) => s.addView)
  const removeView = useStore((s) => s.removeView)
  const renameView = useStore((s) => s.renameView)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const menuRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [menuOpen])

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
    <>
      <header className="flex items-center px-6 h-14 bg-base shrink-0 select-none gap-4">
        <Logo size={30} online={connected} />

        {/* View tabs */}
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto">
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

        {/* Right controls */}
        <div className="flex items-center gap-2.5">
          {onAddWidget && (
            <button
              className="flex items-center gap-2 px-3.5 py-2 text-sm text-text-secondary hover:text-white border border-white/10 hover:border-white/25 rounded-lg transition-colors"
              onClick={onAddWidget}
              title="Add Widget"
            >
              <LayoutGrid size={15} />
              <span className="hidden sm:inline">Add Widget</span>
            </button>
          )}

          {/* Notifications */}
          <NotificationPanel />

          {/* Menu dropdown */}
          <div className="relative" ref={menuRef}>
            <button
              className="flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-white hover:bg-white/[0.06] transition-colors"
              onClick={() => setMenuOpen((v) => !v)}
              title="Menu"
            >
              <Menu size={18} />
            </button>

            {menuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-48 bg-elevated border border-border rounded-xl shadow-xl shadow-black/40 py-1.5 z-50">
                <button
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-text-secondary hover:text-white hover:bg-white/[0.06] transition-colors"
                  onClick={() => { setAgentOpen(true); setMenuOpen(false) }}
                >
                  <Bot size={15} className="text-text-muted" />
                  Agents
                </button>
                <button
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-text-secondary hover:text-white hover:bg-white/[0.06] transition-colors"
                  onClick={() => { setUsageOpen(true); setMenuOpen(false) }}
                >
                  <Activity size={15} className="text-text-muted" />
                  Usage
                </button>
                <button
                  className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-text-secondary hover:text-white hover:bg-white/[0.06] transition-colors"
                  onClick={() => { setPolicyOpen(true); setMenuOpen(false) }}
                >
                  <Shield size={15} className="text-text-muted" />
                  Policies
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {agentOpen && <AgentEditor onClose={() => setAgentOpen(false)} />}
      {policyOpen && <PolicyEditor onClose={() => setPolicyOpen(false)} />}
      {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
    </>
  )
}
