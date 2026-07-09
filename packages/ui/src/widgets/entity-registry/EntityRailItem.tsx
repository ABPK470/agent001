/**
 * Single entity row — thread-rail layout (unified highlight, overlay menu).
 */

import { History, MoreVertical, Pencil, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { EntityRegistryDefinition } from "../../types"

export interface EntityRailItemProps {
  entity: EntityRegistryDefinition
  active: boolean
  isAdmin: boolean
  busy: boolean
  onSelect: () => void
  onHistory: () => void
  onEdit: () => void
  onRetire: () => void
}

export function EntityRailItem({
  entity,
  active,
  isAdmin,
  busy,
  onSelect,
  onHistory,
  onEdit,
  onRetire,
}: EntityRailItemProps): JSX.Element {
  const retired = !!entity.retiredAt
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  function closeMenu(): void {
    setMenuOpen(false)
    setMenuAnchor(null)
  }

  function toggleMenu(): void {
    if (menuOpen) {
      closeMenu()
      return
    }
    const rect = menuBtnRef.current?.getBoundingClientRect()
    if (!rect) return
    setMenuAnchor(rect)
    setMenuOpen(true)
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

  function runAction(action: () => void): void {
    closeMenu()
    action()
  }

  return (
    <li
      className={[
        "entity-rail-item-wrap",
        active ? "entity-rail-item-wrap--active" : "",
        menuOpen ? "entity-rail-item-wrap--menu-open" : "",
        retired ? "entity-rail-item-wrap--retired" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="entity-rail-item-row">
        <button
          type="button"
          onClick={onSelect}
          className="entity-rail-item min-w-0 flex-1 text-left"
        >
          <span className="entity-rail-item-title block min-w-0 truncate">
            {entity.displayName}
          </span>
          <span className="entity-rail-item-meta block min-w-0 truncate font-mono">
            {entity.id}
          </span>
        </button>

        <div ref={menuRef} className="entity-rail-item-menu">
          <button
            ref={menuBtnRef}
            type="button"
            onClick={toggleMenu}
            className="entity-rail-item-menu-btn entity-rail-item-options-btn"
            title={`Actions · ${entity.displayName}`}
            aria-label={`Actions for ${entity.displayName}`}
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
              <button
                type="button"
                role="menuitem"
                className="thread-rail-item-dropdown-item"
                onClick={() => runAction(onHistory)}
              >
                <History size={13} strokeWidth={1.75} />
                <span>History</span>
              </button>
              {isAdmin && !retired && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className="thread-rail-item-dropdown-item"
                    onClick={() => runAction(onEdit)}
                    disabled={busy}
                  >
                    <Pencil size={13} strokeWidth={1.75} />
                    <span>Edit</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="thread-rail-item-dropdown-item thread-rail-item-dropdown-item--danger"
                    onClick={() => runAction(onRetire)}
                    disabled={busy}
                  >
                    <Trash2 size={13} strokeWidth={1.75} />
                    <span>Delete</span>
                  </button>
                </>
              )}
            </div>,
            document.body,
          )}
        </div>
      </div>
    </li>
  )
}
