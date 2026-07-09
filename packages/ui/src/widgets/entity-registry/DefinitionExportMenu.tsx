/**
 * Definition tab — copy, download, compiled bundle.
 */

import { Copy, Download, Package, Share } from "lucide-react"
import type { JSX } from "react"
import { ToolbarMenu, ToolbarMenuItem } from "./ToolbarMenu"

export interface DefinitionExportMenuProps {
  isAdmin: boolean
  bundleBusy: boolean
  onCopy: () => void
  onDownload: () => void
  onCopyBundle: () => void
}

export function DefinitionExportMenu({
  isAdmin,
  bundleBusy,
  onCopy,
  onDownload,
  onCopyBundle,
}: DefinitionExportMenuProps): JSX.Element {
  return (
    <ToolbarMenu
      title="Export definition"
      ariaLabel="Export definition"
      trigger={<Share size={16} />}
      minWidthClass="min-w-[11.5rem]"
    >
      <ToolbarMenuItem icon={<Copy size={14} />} label="Copy to clipboard" onClick={onCopy} />
      <ToolbarMenuItem icon={<Download size={14} />} label="Download file" onClick={onDownload} />
      {isAdmin && (
        <ToolbarMenuItem
          icon={<Package size={14} />}
          label="Copy compiled bundle"
          onClick={onCopyBundle}
          disabled={bundleBusy}
        />
      )}
    </ToolbarMenu>
  )
}
