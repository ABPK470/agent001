/**
 * Definition tab — export single entity JSON (includes run binding).
 */

import { Copy, Download, Share } from "lucide-react"
import type { JSX } from "react"
import { ToolbarMenu, ToolbarMenuItem } from "./ToolbarMenu"

export interface DefinitionExportMenuProps {
  exportBusy: boolean
  onCopyJson: () => void
  onDownloadJson: () => void
}

export function DefinitionExportMenu({
  exportBusy,
  onCopyJson,
  onDownloadJson,
}: DefinitionExportMenuProps): JSX.Element {
  return (
    <ToolbarMenu
      title="Export entity"
      ariaLabel="Export entity"
      trigger={<Share size={16} />}
      minWidthClass="min-w-[11.5rem]"
    >
      <ToolbarMenuItem
        icon={<Copy size={14} />}
        label="Copy entity JSON"
        onClick={onCopyJson}
        disabled={exportBusy}
      />
      <ToolbarMenuItem
        icon={<Download size={14} />}
        label="Download entity JSON"
        onClick={onDownloadJson}
        disabled={exportBusy}
      />
    </ToolbarMenu>
  )
}
