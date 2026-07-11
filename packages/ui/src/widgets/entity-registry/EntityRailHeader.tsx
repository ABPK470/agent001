/**
 * Entity sidebar header — label + compact icon actions.
 */

import { Plus, Settings2 } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { EntityRailPlatformMenu } from "./EntityRailPlatformMenu"
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
              label="Catalog menu"
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
                className="thread-rail-item-dropdown thread-rail-item-dropdown--portal thread-rail-item-dropdown--platform"
                role="menu"
                style={{
                  top: menuAnchor.bottom + 4,
                  left: menuAnchor.left,
                }}
              >
                <EntityRailPlatformMenu
                  busy={busy}
                  onClose={closeMenu}
                  onSyncMetadata={onSyncMetadata}
                  onPublish={onPublish}
                  onExportConfig={onExportConfig}
                  onExportDeployArtifacts={onExportDeployArtifacts}
                  onImportConfig={onImportConfig}
                  onImportDeployArtifacts={onImportDeployArtifacts}
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
