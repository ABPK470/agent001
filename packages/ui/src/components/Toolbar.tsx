/**
 * Toolbar — top bar with branding, view tabs, menu dropdown, and widget button.
 */

import { Activity, Bot, ChevronDown, LayoutGrid, LogOut, Menu, Plus, Shield, Terminal, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import type { Me } from "../hooks/useMe"
import { useStore } from "../store"
import { AgentEditor } from "./AgentEditor"
import { Logo } from "./Logo"
import { NotificationPanel } from "./NotificationPanel"
import { PolicyEditor } from "./PolicyEditor"
import { ThemeToggle } from "./ThemeToggle"
import { UsageModal } from "./UsageModal"

interface Props {
  onAddWidget?: () => void
  onSwitchUser?: () => void
  onSwitchUi?: () => void
  me?: Me | null
}

export function Toolbar({ onAddWidget, onSwitchUser, onSwitchUi, me }: Props) {
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
  // Tab overflow handling: when the tab strip is narrower than its
  // total tab width we expose a "More" dropdown so views aren't lost.
  // Without this, narrow widths (or right-side controls eating space)
  // hide the trailing tabs behind a horizontal scroll users can't see.
  const tabsRef = useRef<HTMLDivElement>(null)
  const [tabsOverflow, setTabsOverflow] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!moreOpen) return
    function handleClick(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [moreOpen])

  // Detect overflow on the tab strip and re-evaluate when views change
  // or the toolbar resizes (e.g. window resize, right-controls grow).
  useEffect(() => {
    const el = tabsRef.current
    if (!el) return
    const check = () => setTabsOverflow(el.scrollWidth > el.clientWidth + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [views.length])

  // Keep the active tab visible when the user switches via the
  // dropdown or programmatically.
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

  return (
    <>
      <header className="flex items-center px-3 sm:px-6 h-14 bg-canvas shrink-0 select-none gap-2 sm:gap-4">
        <Logo size={30} online={connected} />

        {/* View tabs */}
        <div ref={tabsRef} className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto scrollbar-none">
          {views.map((view) => (
            <div
              key={view.id}
              data-view-id={view.id}
              className={`
                group flex items-center gap-1.5 px-3 h-9 text-[13px] cursor-pointer shrink-0
                transition-colors
                ${view.id === activeViewId
                  ? "text-text font-semibold"
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

        {/* "More" dropdown — visible whenever the tab strip overflows
            so trailing views aren't lost behind a scroll the user
            can't see. Always lists every view for quick navigation. */}
        {tabsOverflow && (
          <div className="relative shrink-0" ref={moreRef}>
            <button
              className="flex items-center gap-1 h-9 px-2 text-[13px] text-text-muted hover:text-text hover:bg-overlay-hover rounded-lg transition-colors"
              onClick={() => setMoreOpen((v) => !v)}
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
                    className={`flex items-center justify-between w-full px-4 py-2.5 text-sm transition-colors ${
                      view.id === activeViewId
                        ? "text-text font-semibold bg-overlay-hover"
                        : "text-text-secondary hover:text-text hover:bg-overlay-hover"
                    }`}
                    onClick={() => { setActiveView(view.id); setMoreOpen(false) }}
                  >
                    <span className="truncate">{view.name}</span>
                    {view.id === activeViewId && <span className="text-accent text-xs">●</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Right controls — uniform 36px icon buttons; greeting pinned far right */}
        <div className="flex items-center gap-1">
          {onAddWidget && (
            <button
              className="flex items-center gap-2 h-9 px-3 text-sm text-text-secondary hover:text-text hover:bg-overlay-hover rounded-lg transition-colors"
              onClick={onAddWidget}
              title="Add Widget"
            >
              <LayoutGrid size={16} />
              <span className="hidden sm:inline">Add Widget</span>
            </button>
          )}

          {/* Theme toggle — Light / Dark / System (cycles on click) */}
          <ThemeToggle />

          {/* Notifications */}
          <NotificationPanel />

          {/* Menu dropdown — admin-only. All current items (Agents,
              Usage, Policies) are admin-gated, so for regular users the
              dropdown would render as an empty popover. Hide the
              trigger entirely for them rather than showing an
              actionless icon. */}
          {me?.isAdmin && (
            <div className="relative" ref={menuRef}>
              <button
                className="flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-text hover:bg-overlay-hover transition-colors"
                onClick={() => setMenuOpen((v) => !v)}
                title="Menu"
              >
                <Menu size={18} />
              </button>

              {menuOpen && (
                <div className="absolute right-0 top-full mt-1.5 w-48 bg-panel-2 border border-border rounded-xl shadow-xl shadow-black/40 py-1.5 z-50">
                  <button
                    className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-text-secondary hover:text-text hover:bg-overlay-hover transition-colors"
                    onClick={() => { setAgentOpen(true); setMenuOpen(false) }}
                  >
                    <Bot size={15} className="text-text-muted" />
                    Agents
                  </button>
                  <button
                    className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-text-secondary hover:text-text hover:bg-overlay-hover transition-colors"
                    onClick={() => { setUsageOpen(true); setMenuOpen(false) }}
                  >
                    <Activity size={15} className="text-text-muted" />
                    Usage
                  </button>
                  <button
                    className="flex items-center gap-3 w-full px-4 py-2.5 text-sm text-text-secondary hover:text-text hover:bg-overlay-hover transition-colors"
                    onClick={() => { setPolicyOpen(true); setMenuOpen(false) }}
                  >
                    <Shield size={15} className="text-text-muted" />
                    Policies
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Greeting — pinned far right, separated by a thin divider */}
          {me && me.displayName && me.displayName !== "Anonymous" && (
            <div className="hidden md:flex items-center gap-2 ml-2 pl-3 border-l border-border-subtle text-sm text-text-muted">
              <span className="leading-none">
                Hi, <span className="text-text-secondary">{me.displayName.split(" ")[0]}</span>
              </span>
              {me.isAdmin && (
                <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-soft text-accent leading-none">
                  admin
                </span>
              )}
              <button
                onClick={() => onSwitchUi?.()}
                title="Switch to terminal UI (MI:A/term)"
                className="flex items-center justify-center w-9 h-9 rounded-lg text-accent hover:text-accent-hover hover:bg-overlay-hover transition-colors"
                style={{ display: me?.isAdmin ? undefined : "none" }}
              >
                <Terminal size={16} />
              </button>
              <button
                onClick={() => onSwitchUser?.()}
                title="Switch user"
                className="flex items-center justify-center w-9 h-9 rounded-lg text-text-muted hover:text-text hover:bg-overlay-hover transition-colors"
              >
                <LogOut size={15} />
              </button>
            </div>
          )}
        </div>
      </header>

      {agentOpen && <AgentEditor onClose={() => setAgentOpen(false)} />}
      {policyOpen && <PolicyEditor onClose={() => setPolicyOpen(false)} />}
      {usageOpen && <UsageModal onClose={() => setUsageOpen(false)} />}
    </>
  )
}
