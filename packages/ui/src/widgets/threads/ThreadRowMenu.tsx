import { MoreVertical, Pencil, Pin, Trash2 } from "lucide-react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../../client/index"
import { placeAnchoredPanelForElements } from "../../lib/anchored-panel"
import { useStore } from "../../state/store"
import type { Thread } from "../../types"

const MENU_ESTIMATE = { width: 168, height: 132 }

export function ThreadRowMenu({
  thread,
  onRequestDelete,
  onRenameStart,
  onMenuOpenChange,
}: {
  thread: Thread
  onRequestDelete: () => void
  onRenameStart: () => void
  onMenuOpenChange?: (open: boolean) => void
}) {
  const upsertThread = useStore((s) => s.upsertThread)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const closeMenu = () => {
    setMenuOpen(false)
    setMenuPos(null)
    onMenuOpenChange?.(false)
  }

  function placeMenu(): void {
    const btn = menuBtnRef.current
    if (!btn) return
    const next = placeAnchoredPanelForElements(btn, dropdownRef.current, {
      align: "end",
      estimate: MENU_ESTIMATE,
    })
    setMenuPos({ top: next.top, left: next.left })
  }

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

  const togglePin = async () => {
    closeMenu()
    try {
      const updated = await api.updateThread(thread.id, { pinned: !thread.pinned })
      upsertThread(updated)
    } catch {
      /* ignore */
    }
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
      estimate: MENU_ESTIMATE,
    })
    setMenuPos({ top: next.top, left: next.left })
    setMenuOpen(true)
    onMenuOpenChange?.(true)
  }

  return (
    <div ref={menuRef} className="thread-row-menu">
      {thread.pinned && (
        <span className="thread-nav-pin-slot" title="Pinned" aria-label="Pinned">
          <Pin size={15} strokeWidth={1.75} />
        </span>
      )}
      <button
        ref={menuBtnRef}
        type="button"
        onClick={toggleMenu}
        className="thread-nav-options-btn"
        title="Thread options"
        aria-label="Thread options"
        aria-expanded={menuOpen}
        aria-haspopup="menu"
      >
        <MoreVertical size={15} strokeWidth={1.75} />
      </button>

      {menuOpen && menuPos && createPortal(
        <div
          ref={dropdownRef}
          className="thread-rail-item-dropdown thread-rail-item-dropdown--portal"
          role="menu"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <button type="button" role="menuitem" className="thread-rail-item-dropdown-item" onClick={() => void togglePin()}>
            <Pin size={13} strokeWidth={1.75} />
            <span>{thread.pinned ? "Unpin" : "Pin"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="thread-rail-item-dropdown-item"
            onClick={() => {
              closeMenu()
              onRenameStart()
            }}
          >
            <Pencil size={13} strokeWidth={1.75} />
            <span>Rename</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="thread-rail-item-dropdown-item thread-rail-item-dropdown-item--danger"
            onClick={() => {
              closeMenu()
              onRequestDelete()
            }}
          >
            <Trash2 size={13} strokeWidth={1.75} />
            <span>Delete</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
