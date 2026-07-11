/**
 * Entity rail platform menu — edit, transfer, and release catalog state.
 *
 * Flat, explicit actions only — no mode toggle. Each row is one verb + one target.
 */

import { Download, History, Rocket, Upload, Workflow } from "lucide-react"
import type { JSX, ReactNode } from "react"

export interface EntityRailPlatformMenuProps {
  busy: boolean
  onClose: () => void
  onSyncMetadata: () => void
  onPublish: () => void
  onExportConfig: () => void
  onExportDeployArtifacts: () => void
  onImportConfig: () => void
  onImportDeployArtifacts: () => void
  onCatalogVersions: () => void
}

const ICON = { size: 13, strokeWidth: 1.75 } as const

function runAndClose(action: () => void, onClose: () => void): void {
  onClose()
  action()
}

function MenuSection({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="thread-rail-item-dropdown__section" role="group" aria-label={label}>
      <span className="thread-rail-item-dropdown__section-label">{label}</span>
      {children}
    </div>
  )
}

function MenuItem({
  icon,
  label,
  disabled,
  emphasis,
  onClick,
}: {
  icon: ReactNode
  label: string
  disabled?: boolean
  emphasis?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      className={[
        "thread-rail-item-dropdown-item",
        emphasis ? "thread-rail-item-dropdown-item--emphasis" : "",
      ].filter(Boolean).join(" ")}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

export function EntityRailPlatformMenu({
  busy,
  onClose,
  onSyncMetadata,
  onPublish,
  onExportConfig,
  onExportDeployArtifacts,
  onImportConfig,
  onImportDeployArtifacts,
  onCatalogVersions,
}: EntityRailPlatformMenuProps): JSX.Element {
  const run = (action: () => void) => () => runAndClose(action, onClose)

  return (
    <>
      <MenuItem
        icon={<Workflow {...ICON} />}
        label="Edit flows & wiring"
        disabled={busy}
        onClick={run(onSyncMetadata)}
      />

      <div className="thread-rail-item-dropdown__separator" role="separator" />

      <MenuSection label="Export">
        <MenuItem
          icon={<Download {...ICON} />}
          label="Catalog snapshot"
          disabled={busy}
          onClick={run(onExportConfig)}
        />
        <MenuItem
          icon={<Download {...ICON} />}
          label="Deploy artifacts"
          disabled={busy}
          onClick={run(onExportDeployArtifacts)}
        />
      </MenuSection>

      <MenuSection label="Import">
        <MenuItem
          icon={<Upload {...ICON} />}
          label="Catalog snapshot"
          disabled={busy}
          onClick={run(onImportConfig)}
        />
        <MenuItem
          icon={<Upload {...ICON} />}
          label="Deploy artifacts"
          disabled={busy}
          onClick={run(onImportDeployArtifacts)}
        />
      </MenuSection>

      <div className="thread-rail-item-dropdown__separator" role="separator" />

      <MenuItem
        icon={<History {...ICON} />}
        label="Catalog versions"
        disabled={busy}
        onClick={run(onCatalogVersions)}
      />
      <MenuItem
        icon={<Rocket {...ICON} />}
        label="Publish all"
        disabled={busy}
        emphasis
        onClick={run(onPublish)}
      />
    </>
  )
}
