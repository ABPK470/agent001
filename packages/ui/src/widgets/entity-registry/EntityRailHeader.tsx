/**
 * Entity sidebar header — label + compact icon actions.
 */

import { Download, History, Plus, Rocket, Settings2, Upload, Workflow } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { IconButton, TOOLBAR_ICON } from "./IconButton"

export interface EntityRailHeaderProps {
  isAdmin: boolean
  busy: boolean
  onNew: () => void
  onSyncMetadata: () => void
  onPublish: () => void
  onExportConfig: () => void
  onExportDeployArtifacts: () => void
  onImportConfig: () => void
  onImportDeployArtifacts: () => void
  onCatalogVersions: () => void
}

export function EntityRailHeader({
  isAdmin,
  busy,
  onNew,
  onSyncMetadata,
  onPublish,
  onExportConfig,
  onExportDeployArtifacts,
  onImportConfig,
  onImportDeployArtifacts,
  onCatalogVersions,
}: EntityRailHeaderProps): JSX.Element {
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
              label="Entity registry platform"
              onClick={toggleMenu}
              disabled={busy}
              active={menuOpen}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
            >
              <Settings2 {...TOOLBAR_ICON} />
            </IconButton>
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
                  onClick={() => { closeMenu(); onSyncMetadata() }}
                >
                  <Workflow size={13} strokeWidth={1.75} />
                  <span>Configuration</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="thread-rail-item-dropdown-item"
                  onClick={() => { closeMenu(); onImportConfig() }}
                >
                  <Upload size={13} strokeWidth={1.75} />
                  <span>Import catalog snapshot</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="thread-rail-item-dropdown-item"
                  onClick={() => { closeMenu(); onImportDeployArtifacts() }}
                >
                  <Upload size={13} strokeWidth={1.75} />
                  <span>Import deploy artifacts</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="thread-rail-item-dropdown-item"
                  onClick={() => { closeMenu(); onExportConfig() }}
                >
                  <Download size={13} strokeWidth={1.75} />
                  <span>Export catalog snapshot</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="thread-rail-item-dropdown-item"
                  onClick={() => { closeMenu(); onExportDeployArtifacts() }}
                >
                  <Download size={13} strokeWidth={1.75} />
                  <span>Export deploy artifacts</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="thread-rail-item-dropdown-item"
                  onClick={() => { closeMenu(); onCatalogVersions() }}
                >
                  <History size={13} strokeWidth={1.75} />
                  <span>Configuration versions</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="thread-rail-item-dropdown-item"
                  onClick={() => { closeMenu(); onPublish() }}
                >
                  <Rocket size={13} strokeWidth={1.75} />
                  <span>Publish all</span>
                </button>
              </div>,
              document.body,
            )}
          </div>
        </div>
      )}
    </div>
  )
}
