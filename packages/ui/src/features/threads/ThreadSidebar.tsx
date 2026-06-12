import { MoreVertical, PanelLeft, PanelLeftClose, Pin, Plus, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../../api"
import { useStore } from "../../store"
import type { Thread } from "../../types"

interface Props {
  threads: Thread[]
  activeThreadId: string | null
  collapsed: boolean
  railFits: boolean
  onToggleCollapsed: () => void
  onSelect: (threadId: string) => void
  onNewThread: () => void
  drawerOpen?: boolean
  onDrawerClose?: () => void
}

function ThreadRailItem({
  thread,
  active,
  onSelect,
}: {
  thread: Thread
  active: boolean
  onSelect: () => void
}) {
  const upsertThread = useStore((s) => s.upsertThread)
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  const [draft, setDraft] = useState(thread.title || "New thread")
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const [titleTooltipOpen, setTitleTooltipOpen] = useState(false)
  const [titleTooltipAnchor, setTitleTooltipAnchor] = useState<DOMRect | null>(null)
  const [titleTruncated, setTitleTruncated] = useState(false)
  const displayTitle = thread.title || "New thread"

  const closeTitleTooltip = () => {
    setTitleTooltipOpen(false)
    setTitleTooltipAnchor(null)
  }

  const closeMenu = () => {
    setMenuOpen(false)
    setMenuAnchor(null)
    closeTitleTooltip()
  }

  useEffect(() => {
    if (!editing) setDraft(displayTitle)
  }, [displayTitle, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || dropdownRef.current?.contains(target)) return
      closeMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu()
    }
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const reposition = () => {
      const rect = menuBtnRef.current?.getBoundingClientRect()
      if (rect) setMenuAnchor(rect)
    }
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    return () => {
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    }
  }, [menuOpen])

  const commitRename = async () => {
    const next = draft.trim() || "New thread"
    setEditing(false)
    if (next === displayTitle) return
    try {
      const updated = await api.updateThread(thread.id, { title: next })
      upsertThread(updated)
    } catch {
      setDraft(displayTitle)
    }
  }

  const togglePin = async () => {
    closeMenu()
    try {
      const updated = await api.updateThread(thread.id, { pinned: !thread.pinned })
      upsertThread(updated)
    } catch {
      /* ignore */
    }
  }

  const startRename = () => {
    closeMenu()
    setDraft(displayTitle)
    setEditing(true)
  }

  const toggleMenu = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (menuOpen) {
      closeMenu()
      return
    }
    const rect = menuBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuAnchor(rect)
    setMenuOpen(true)
  }

  const refreshTitleTruncation = () => {
    const el = titleRef.current
    if (!el) return false
    const truncated = el.scrollWidth > el.clientWidth + 1
    setTitleTruncated(truncated)
    return truncated
  }

  const openTitleTooltip = () => {
    if (menuOpen || editing) return
    if (!refreshTitleTruncation()) return
    const rect = rowRef.current?.getBoundingClientRect()
    if (!rect) return
    setTitleTooltipAnchor(rect)
    setTitleTooltipOpen(true)
  }

  if (editing) {
    return (
      <div className="thread-rail-item-wrap thread-rail-item-wrap--editing">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void commitRename()
            }
            if (event.key === "Escape") {
              setDraft(displayTitle)
              setEditing(false)
            }
          }}
          className="thread-rail-rename-input"
          aria-label="Rename thread"
        />
      </div>
    )
  }

  return (
    <div
      className={`thread-rail-item-wrap group ${active ? "thread-rail-item-wrap--active" : ""} ${
        thread.pinned ? "thread-rail-item-wrap--pinned" : ""
      } ${menuOpen ? "thread-rail-item-wrap--menu-open" : ""}`}
    >
      <div
        ref={rowRef}
        className="thread-rail-item-row"
        onMouseEnter={openTitleTooltip}
        onMouseLeave={closeTitleTooltip}
        onFocus={openTitleTooltip}
        onBlur={closeTitleTooltip}
      >
        <button
          type="button"
          onClick={onSelect}
          className="thread-rail-item min-w-0 flex-1 text-left"
        >
          <div className="thread-rail-item-title-line min-w-0">
            <span ref={titleRef} className="thread-rail-item-title block min-w-0 truncate">
              {displayTitle}
            </span>
          </div>
        </button>

        <div ref={menuRef} className="thread-rail-item-menu relative shrink-0">
          {thread.pinned && (
            <span
              className="thread-rail-item-menu-btn thread-rail-item-pin-slot"
              title="Pinned"
              aria-label="Pinned"
            >
              <Pin size={15} strokeWidth={1.75} />
            </span>
          )}
          <button
            ref={menuBtnRef}
            type="button"
            onClick={toggleMenu}
            className="thread-rail-item-menu-btn thread-rail-item-options-btn"
            title="Thread options"
            aria-label="Thread options"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <MoreVertical size={15} strokeWidth={1.75} />
          </button>

          {titleTooltipOpen && titleTooltipAnchor && titleTruncated && createPortal(
            <div
              className="thread-rail-title-tooltip"
              role="tooltip"
              style={{
                top: titleTooltipAnchor.top + titleTooltipAnchor.height / 2,
                left: titleTooltipAnchor.right + 10,
              }}
            >
              {displayTitle}
            </div>,
            document.body,
          )}

          {menuOpen && menuAnchor && createPortal(
            <div
              ref={dropdownRef}
              className="thread-rail-item-dropdown thread-rail-item-dropdown--portal"
              role="menu"
              style={{
                top: menuAnchor.bottom + 4,
                left: menuAnchor.right,
              }}
            >
              <button
                type="button"
                role="menuitem"
                className="thread-rail-item-dropdown-item"
                onClick={() => void togglePin()}
              >
                <Pin size={13} strokeWidth={1.75} />
                <span>{thread.pinned ? "Unpin" : "Pin"}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="thread-rail-item-dropdown-item"
                onClick={startRename}
              >
                <span>Rename</span>
              </button>
            </div>,
            document.body,
          )}
        </div>
      </div>
    </div>
  )
}

export function ThreadSidebar({
  threads,
  activeThreadId,
  collapsed,
  railFits,
  onToggleCollapsed,
  onSelect,
  onNewThread,
  drawerOpen = false,
  onDrawerClose,
}: Props): React.ReactElement {
  const railLabel = collapsed ? "Show threads" : "Hide threads"

  return (
    <>
      {drawerOpen && (
        <button
          type="button"
          aria-label="Close threads"
          className="thread-rail-scrim fixed inset-0 z-40"
          onClick={onDrawerClose}
        />
      )}

      <aside
        className={`thread-rail ${collapsed ? "thread-rail--collapsed" : "thread-rail--expanded"} ${
          drawerOpen
            ? "thread-rail--mobile-open"
            : railFits
              ? "thread-rail--desktop"
              : "thread-rail--offstage"
        }`}
        aria-label="Threads"
        aria-hidden={!railFits && !drawerOpen}
      >
        <div
          className={`thread-rail-inner flex h-full min-h-0 flex-col ${
            drawerOpen
              ? "thread-rail-inner--drawer rounded-[24px] border border-border bg-panel"
              : "thread-rail-inner--overlay"
          }`}
        >
          <div className="thread-rail-section-head">
            {/* <span className="thread-rail-section-label">Threads</span> */}
            <div className="thread-rail-section-actions">
              <button
                type="button"
                onClick={onNewThread}
                className="thread-rail-new"
                title="New thread"
              >
                <Plus size={16} strokeWidth={2} />
                <span>New</span>
              </button>
              {drawerOpen ? (
                <button
                  type="button"
                  onClick={onDrawerClose}
                  className="thread-rail-toggle"
                  title="Close threads"
                  aria-label="Close threads"
                >
                  <X size={17} strokeWidth={1.75} />
                </button>
              ) : (
                railFits && (
                  <button
                    type="button"
                    onClick={onToggleCollapsed}
                    className="thread-rail-toggle hidden lg:inline-flex"
                    title={railLabel}
                    aria-label={railLabel}
                    aria-expanded
                  >
                    <PanelLeftClose size={17} strokeWidth={1.75} />
                  </button>
                )
              )}
            </div>
          </div>

          <div className="thread-rail-list min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
            {threads.map((thread) => (
              <ThreadRailItem
                key={thread.id}
                thread={thread}
                active={thread.id === activeThreadId}
                onSelect={() => {
                  onSelect(thread.id)
                  onDrawerClose?.()
                }}
              />
            ))}
          </div>
        </div>
      </aside>

      {railFits && !drawerOpen && (
        <button
          type="button"
          onClick={onToggleCollapsed}
          className={`thread-rail-collapsed-trigger hidden xl:inline-flex ${
            collapsed ? "thread-rail-collapsed-trigger--visible" : ""
          }`}
          title={railLabel}
          aria-label={railLabel}
          aria-expanded={false}
        >
          <PanelLeft size={17} strokeWidth={1.75} />
          <span>Threads</span>
        </button>
      )}
    </>
  )
}
