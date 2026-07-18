/**
 * Entity sidebar header — label + compact icon actions.
 */

import { Plus, Settings2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { placeAnchoredPanelForElements } from "../../lib/anchored-panel"
import { EntityRailPlatformMenu } from "./EntityRailPlatformMenu"
import { IconButton, TOOLBAR_ICON } from "./IconButton"

const PLATFORM_MENU_ESTIMATE = { width: 240, height: 320 }

export interface EntityRailHeaderProps {
  isAdmin: boolean
  busy: boolean
  onNew: () => void
  onSyncMetadata: () => void
  onPublish: () => void
  onExportConfig: () => void
  onImportConfig: () => void
  onCatalogVersions: () => void
}

export function EntityRailHeader({
  isAdmin,
  busy,
  onNew,
  onSyncMetadata,
  onPublish,
  onExportConfig,
  onImportConfig,
  onCatalogVersions,
}: EntityRailHeaderProps): JSX.Element {
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
      align: "start",
      estimate: PLATFORM_MENU_ESTIMATE,
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
      align: "start",
      estimate: PLATFORM_MENU_ESTIMATE,
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

  return (
    <div className="entity-rail-header">
      <span className="entity-rail-header__label">Entities</span>
      {isAdmin && (
        <div className="entity-rail-header__actions">
          <IconButton label="New entity" onClick={onNew} disabled={busy}>
            <Plus {...TOOLBAR_ICON} />
          </IconButton>
          <div ref={menuRef} className="relative">
            <IconButton
              ref={menuBtnRef}
              label="Catalog menu"
              onClick={toggleMenu}
              disabled={busy}
              active={menuOpen}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <Settings2 {...TOOLBAR_ICON} />
            </IconButton>
            {menuOpen && menuPos && createPortal(
              <div
                ref={dropdownRef}
                className="thread-rail-item-dropdown thread-rail-item-dropdown--portal thread-rail-item-dropdown--platform"
                role="menu"
                style={{ top: menuPos.top, left: menuPos.left }}
              >
                <EntityRailPlatformMenu
                  busy={busy}
                  onClose={closeMenu}
                  onSyncMetadata={onSyncMetadata}
                  onPublish={onPublish}
                  onExportConfig={onExportConfig}
                  onImportConfig={onImportConfig}
                  onCatalogVersions={onCatalogVersions}
                />
              </div>,
              document.body,
            )}
          </div>
        </div>
      )}
    </div>
  )
}
