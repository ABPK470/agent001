import { MoreVertical, PanelLeft, PanelLeftClose, Pencil, Pin, Plus, Trash2 } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../../client/index"
import { TruncationHint, isTextTruncated } from "../../components/TruncationHint"
import { placeAnchoredPanelForElements } from "../../lib/anchored-panel"
import { useStore } from "../../state/store"
import type { Thread } from "../../types"

const THREAD_MENU_ESTIMATE = { width: 168, height: 132 }
import { DeleteThreadModal } from "./DeleteThreadModal"
import { ThreadsDrawerModal } from "./ThreadsDrawerModal"
import { ThreadTitleMaterialize } from "./ThreadTitleMaterialize"

interface Props {
  threads: Thread[]
  activeThreadId: string | null
  collapsed: boolean
  railFits: boolean
  overlayRailEnabled?: boolean
  onToggleCollapsed: () => void
  onSelect: (threadId: string) => void
  onNewThread: () => void
  drawerOpen?: boolean
  onDrawerClose?: () => void
}

function ThreadRailItem({
  thread,
  active,
  sidebarExpanded = false,
  onSelect,
  onRequestDelete,
}: {
  thread: Thread
  active: boolean
  sidebarExpanded?: boolean
  onSelect: () => void
  onRequestDelete: () => void
}) {
  const upsertThread = useStore((s) => s.upsertThread)
  const threadTitleShellId = useStore((s) => s.threadTitleShellId)
  const threadTitleReveal = useStore((s) => s.threadTitleReveal)
  const clearThreadTitleAnimation = useStore((s) => s.clearThreadTitleAnimation)
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
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
  const revealText =
    sidebarExpanded && threadTitleReveal?.threadId === thread.id
      ? threadTitleReveal.text
      : null
  const showMaterialize =
    sidebarExpanded &&
    (threadTitleShellId === thread.id || revealText != null)
  const shellActive = showMaterialize && threadTitleShellId === thread.id && !revealText
  const rowMaterializing = showMaterialize && shellActive

  const onRevealComplete = useCallback(
    (finalTitle: string) => {
      clearThreadTitleAnimation(thread.id, finalTitle)
    },
    [clearThreadTitleAnimation, thread.id],
  )

  const closeTitleTooltip = () => {
    setTitleTooltipOpen(false)
    setTitleTooltipAnchor(null)
  }

  const closeMenu = () => {
    setMenuOpen(false)
    setMenuPos(null)
    closeTitleTooltip()
  }

  function placeMenu(): void {
    const btn = menuBtnRef.current
    if (!btn) return
    const next = placeAnchoredPanelForElements(btn, dropdownRef.current, {
      align: "end",
      estimate: THREAD_MENU_ESTIMATE,
    })
    setMenuPos({ top: next.top, left: next.left })
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

  useLayoutEffect(() => {
    if (!menuOpen) return
    placeMenu()
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const reposition = () => placeMenu()
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

  const requestDelete = () => {
    closeMenu()
    onRequestDelete()
  }

  const toggleMenu = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (menuOpen) {
      closeMenu()
      return
    }
    const btn = menuBtnRef.current
    if (!btn) return
    const next = placeAnchoredPanelForElements(btn, null, {
      align: "end",
      estimate: THREAD_MENU_ESTIMATE,
    })
    setMenuPos({ top: next.top, left: next.left })
    setMenuOpen(true)
  }

  const refreshTitleTruncation = () => {
    const truncated = isTextTruncated(titleRef.current)
    setTitleTruncated(truncated)
    return truncated
  }

  const openTitleTooltip = () => {
    if (menuOpen || editing || showMaterialize) return
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
      } ${menuOpen ? "thread-rail-item-wrap--menu-open" : ""}${
        rowMaterializing ? " thread-rail-item-wrap--materializing" : ""
      }`}
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
            {showMaterialize ? (
              <ThreadTitleMaterialize
                title={displayTitle}
                shellActive={shellActive}
                revealText={revealText}
                onRevealComplete={onRevealComplete}
              />
            ) : (
              <span ref={titleRef} className="thread-rail-item-title block min-w-0 truncate">
                {displayTitle}
              </span>
            )}
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

          {titleTooltipOpen && titleTooltipAnchor && titleTruncated && (
            <TruncationHint text={displayTitle} anchor={titleTooltipAnchor} />
          )}

          {menuOpen && menuPos && createPortal(
            <div
              ref={dropdownRef}
              className="thread-rail-item-dropdown thread-rail-item-dropdown--portal"
              role="menu"
              style={{ top: menuPos.top, left: menuPos.left }}
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
                <Pencil size={13} strokeWidth={1.75} />
                <span>Rename</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="thread-rail-item-dropdown-item thread-rail-item-dropdown-item--danger"
                onClick={requestDelete}
              >
                <Trash2 size={13} strokeWidth={1.75} />
                <span>Delete</span>
              </button>
            </div>,
            document.body,
          )}
        </div>
      </div>
    </div>
  )
}

function ThreadRailList({
  threads,
  activeThreadId,
  onSelect,
  onRequestDelete,
  drawerClose,
  sidebarExpanded = false,
}: {
  threads: Thread[]
  activeThreadId: string | null
  onSelect: (threadId: string) => void
  onRequestDelete: (thread: Thread) => void
  drawerClose?: () => void
  sidebarExpanded?: boolean
}) {
  return (
    <div className="thread-rail-list min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {threads.map((thread) => (
        <ThreadRailItem
          key={thread.id}
          thread={thread}
          active={thread.id === activeThreadId}
          sidebarExpanded={sidebarExpanded}
          onSelect={() => {
            onSelect(thread.id)
            drawerClose?.()
          }}
          onRequestDelete={() => onRequestDelete(thread)}
        />
      ))}
    </div>
  )
}

export function ThreadSidebar({
  threads,
  activeThreadId,
  collapsed,
  railFits,
  overlayRailEnabled = railFits,
  onToggleCollapsed,
  onSelect,
  onNewThread,
  drawerOpen = false,
  onDrawerClose,
}: Props): React.ReactElement {
  const deleteThread = useStore((s) => s.deleteThread)
  const [pendingDelete, setPendingDelete] = useState<Thread | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const railLabel = collapsed ? "Show threads" : "Hide threads"
  const railExpanded = drawerOpen || !collapsed

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteThread(pendingDelete.id)
      setPendingDelete(null)
      onDrawerClose?.()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete thread")
    } finally {
      setDeleting(false)
    }
  }

  const listProps = {
    threads,
    activeThreadId,
    onSelect,
    onRequestDelete: (thread: Thread) => {
      setDeleteError(null)
      setPendingDelete(thread)
    },
    drawerClose: onDrawerClose,
  }

  return (
    <>
      <ThreadsDrawerModal
        open={drawerOpen}
        onClose={() => onDrawerClose?.()}
        onNewThread={onNewThread}
      >
        <ThreadRailList {...listProps} sidebarExpanded={railExpanded} />
      </ThreadsDrawerModal>

      {overlayRailEnabled && !drawerOpen && (
        <aside
          className={`thread-rail thread-rail--overlay${railExpanded ? " thread-rail--overlay--open" : ""}`}
          aria-label="Threads"
          aria-hidden={!railExpanded}
        >
          <div className="thread-rail-inner thread-rail-inner--overlay flex h-full min-h-0 flex-col">
            <ThreadRailList {...listProps} sidebarExpanded={railExpanded} />
          </div>
        </aside>
      )}

      {overlayRailEnabled && !drawerOpen && (
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

      {pendingDelete && (
        <DeleteThreadModal
          thread={pendingDelete}
          busy={deleting}
          error={deleteError}
          onClose={() => {
            if (!deleting) {
              setPendingDelete(null)
              setDeleteError(null)
            }
          }}
          onConfirm={confirmDelete}
        />
      )}
    </>
  )
}

export function ThreadRailNewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="thread-rail-toggle"
      title="New thread"
      aria-label="New thread"
    >
      <Plus size={17} strokeWidth={2} />
    </button>
  )
}

export function ThreadRailCollapseButton({
  onClick,
  title,
}: {
  onClick: () => void
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="thread-rail-toggle thread-rail-collapse-btn hidden lg:inline-flex"
      title={title}
      aria-label={title}
      aria-expanded
    >
      <PanelLeft size={17} strokeWidth={1.75} className="thread-rail-collapse-icon thread-rail-collapse-icon--rest" />
      <PanelLeftClose size={17} strokeWidth={1.75} className="thread-rail-collapse-icon thread-rail-collapse-icon--hover" />
    </button>
  )
}
