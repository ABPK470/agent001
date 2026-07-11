/**
 * Definition tab — export single entity as registry JSON (B) or deploy artifact (A).
 */

import { Copy, Download, Share } from "lucide-react"
import type { JSX } from "react"
import { ToolbarMenu, ToolbarMenuItem } from "./ToolbarMenu"

export interface DefinitionExportMenuProps {
  exportBusy: boolean
  onCopyRegistryJson: () => void
  onDownloadRegistryJson: () => void
  onCopyDeployArtifact: () => void
  onDownloadDeployArtifact: () => void
}

export function DefinitionExportMenu({
  exportBusy,
  onCopyRegistryJson,
  onDownloadRegistryJson,
  onCopyDeployArtifact,
  onDownloadDeployArtifact,
}: DefinitionExportMenuProps): JSX.Element {
  return (
    <ToolbarMenu
      title="Export entity"
      ariaLabel="Export entity"
      trigger={<Share size={16} />}
      minWidthClass="min-w-[14rem]"
    >
      <ToolbarMenuItem
        icon={<Copy size={14} />}
        label="Copy registry JSON"
        onClick={onCopyRegistryJson}
        disabled={exportBusy}
      />
      <ToolbarMenuItem
        icon={<Download size={14} />}
        label="Download registry JSON"
        onClick={onDownloadRegistryJson}
        disabled={exportBusy}
      />
      <div className="my-1 border-t border-border-subtle" role="separator" />
      <ToolbarMenuItem
        icon={<Copy size={14} />}
        label="Copy deploy artifact"
        onClick={onCopyDeployArtifact}
        disabled={exportBusy}
      />
      <ToolbarMenuItem
        icon={<Download size={14} />}
        label="Download deploy artifact"
        onClick={onDownloadDeployArtifact}
        disabled={exportBusy}
      />
    </ToolbarMenu>
  )
}
