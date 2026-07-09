import { MoreVertical, Pencil, Pin, Trash2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "../../api"
import { useStore } from "../../store"
import type { Thread } from "../../types"

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
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const closeMenu = () => {
    setMenuOpen(false)
    setMenuAnchor(null)
    onMenuOpenChange?.(false)
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
    const rect = menuBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuAnchor(rect)
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
