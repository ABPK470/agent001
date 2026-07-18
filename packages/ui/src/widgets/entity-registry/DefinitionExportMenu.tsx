/**
 * Definition tab — import/export with copy-or-download mode toggle.
 * Catalog dialect only (Registry JSON) — no Deploy/Authored artifact path.
 */

import { ArrowUpDown, Copy, Download, Upload } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { RegistryModeToggle } from "./RegistryModeToggle"
import { ToolbarMenu, ToolbarMenuItem } from "./ToolbarMenu"

export type DefinitionExportMode = "copy" | "download"

export interface DefinitionExportMenuProps {
  exportBusy: boolean
  onCopyRegistryJson: () => void
  onDownloadRegistryJson: () => void
  onImportRegistryJson?: () => void
}

function stopMenuClose(event: { stopPropagation: () => void }): void {
  event.stopPropagation()
}

export function DefinitionExportMenu({
  exportBusy,
  onCopyRegistryJson,
  onDownloadRegistryJson,
  onImportRegistryJson,
}: DefinitionExportMenuProps): JSX.Element {
  const [mode, setMode] = useState<DefinitionExportMode>("copy")
  const exportIcon = mode === "copy" ? <Copy size={14} /> : <Download size={14} />

  return (
    <ToolbarMenu
      title="Import / export entity"
      ariaLabel="Import / export entity"
      trigger={<ArrowUpDown size={16} />}
      minWidthClass="min-w-[14rem]"
    >
      <div
        className="border-b border-border-subtle px-2 py-2"
        onClick={stopMenuClose}
        onKeyDown={stopMenuClose}
      >
        <RegistryModeToggle
          value={mode}
          options={[
            { value: "copy", label: "Copy" },
            { value: "download", label: "Download" },
          ]}
          onChange={setMode}
          ariaLabel="Export mode"
          disabled={exportBusy}
        />
      </div>

      <ToolbarMenuItem
        icon={exportIcon}
        label="Registry JSON"
        onClick={mode === "copy" ? onCopyRegistryJson : onDownloadRegistryJson}
        disabled={exportBusy}
      />
      {onImportRegistryJson && (
        <>
          <div className="my-1 border-t border-border-subtle" role="separator" />
          <ToolbarMenuItem
            icon={<Upload size={14} />}
            label="Import registry JSON"
            onClick={onImportRegistryJson}
            disabled={exportBusy}
          />
        </>
      )}
    </ToolbarMenu>
  )
}
