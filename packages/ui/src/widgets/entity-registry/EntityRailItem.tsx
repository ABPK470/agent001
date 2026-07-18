/**
 * Single entity row — thread-rail layout (unified highlight, overlay menu).
 */

import { History, MoreVertical, Pencil, Trash2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { placeAnchoredPanelForElements } from "../../lib/anchored-panel"
import type { EntityRegistryDefinition } from "../../types"

const MENU_ESTIMATE = { width: 168, height: 132 }

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
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  function closeMenu(): void {
    setMenuOpen(false)
    setMenuPos(null)
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

  function toggleMenu(): void {
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
  }

  useLayoutEffect(() => {
    if (!menuOpen) return
    placeMenu()
  }, [menuOpen])

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
    const reposition = () => placeMenu()
    document.addEventListener("mousedown", onPointerDown)
    document.addEventListener("keydown", onKeyDown)
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    return () => {
      document.removeEventListener("mousedown", onPointerDown)
      document.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
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
