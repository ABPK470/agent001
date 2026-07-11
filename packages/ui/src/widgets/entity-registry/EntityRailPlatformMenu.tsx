/**
 * Entity rail platform menu — configuration, import/export, publish.
 */

import { Download, History, Rocket, Upload, Workflow } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { RegistryModeToggle } from "./RegistryModeToggle"

export type PlatformRegistryMode = "import" | "export"

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

function runAndClose(action: () => void, onClose: () => void): void {
  onClose()
  action()
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
  const [mode, setMode] = useState<PlatformRegistryMode>("export")
  const actionIcon = mode === "export"
    ? <Download size={13} strokeWidth={1.75} />
    : <Upload size={13} strokeWidth={1.75} />

  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="thread-rail-item-dropdown-item"
        disabled={busy}
        onClick={() => runAndClose(onSyncMetadata, onClose)}
      >
        <Workflow size={13} strokeWidth={1.75} />
        <span>Configuration</span>
      </button>

      <div className="thread-rail-item-dropdown__toggle">
        <RegistryModeToggle
          value={mode}
          options={[
            { value: "export", label: "Export" },
            { value: "import", label: "Import" },
          ]}
          onChange={setMode}
          ariaLabel="Import or export"
          disabled={busy}
        />
      </div>

      <button
        type="button"
        role="menuitem"
        className="thread-rail-item-dropdown-item"
        disabled={busy}
        onClick={() => runAndClose(
          mode === "export" ? onExportConfig : onImportConfig,
          onClose,
        )}
      >
        {actionIcon}
        <span>Catalog snapshot</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="thread-rail-item-dropdown-item"
        disabled={busy}
        onClick={() => runAndClose(
          mode === "export" ? onExportDeployArtifacts : onImportDeployArtifacts,
          onClose,
        )}
      >
        {actionIcon}
        <span>Deploy artifacts</span>
      </button>

      <div className="thread-rail-item-dropdown__separator" role="separator" />

      <button
        type="button"
        role="menuitem"
        className="thread-rail-item-dropdown-item"
        disabled={busy}
        onClick={() => runAndClose(onCatalogVersions, onClose)}
      >
        <History size={13} strokeWidth={1.75} />
        <span>Configuration versions</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="thread-rail-item-dropdown-item"
        disabled={busy}
        onClick={() => runAndClose(onPublish, onClose)}
      >
        <Rocket size={13} strokeWidth={1.75} />
        <span>Publish all</span>
      </button>
    </>
  )
}
