/**
 * Per-entity Catalog JSON import/export.
 * Menu title names the object; items are verbs only — no TypeScript type names in UI.
 */

import { ArrowUpDown, Copy, Download, Upload } from "lucide-react"
import type { JSX } from "react"
import { ToolbarMenu, ToolbarMenuItem } from "./ToolbarMenu"

export interface EntityJsonExportMenuProps {
  exportBusy: boolean
  onCopyRegistryJson: () => void
  onDownloadRegistryJson: () => void
  onImportRegistryJson?: () => void
}

export function EntityJsonExportMenu({
  exportBusy,
  onCopyRegistryJson,
  onDownloadRegistryJson,
  onImportRegistryJson,
}: EntityJsonExportMenuProps): JSX.Element {
  return (
    <ToolbarMenu
      title="Entity JSON"
      ariaLabel="Copy, download, or import this entity as JSON"
      trigger={<ArrowUpDown size={16} />}
      minWidthClass="min-w-[10rem]"
    >
      <ToolbarMenuItem
        icon={<Copy size={14} />}
        label="Copy"
        onClick={onCopyRegistryJson}
        disabled={exportBusy}
      />
      <ToolbarMenuItem
        icon={<Download size={14} />}
        label="Download"
        onClick={onDownloadRegistryJson}
        disabled={exportBusy}
      />
      {onImportRegistryJson && (
        <>
          <div className="my-1 border-t border-border-subtle" role="separator" />
          <ToolbarMenuItem
            icon={<Upload size={14} />}
            label="Import"
            onClick={onImportRegistryJson}
            disabled={exportBusy}
          />
        </>
      )}
    </ToolbarMenu>
  )
}
