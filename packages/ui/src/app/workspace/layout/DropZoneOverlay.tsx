import { rectToPixels, ROW_PX } from "../../../lib/grid-math"
import type { DropPreview } from "./useGridInteraction"

interface Props {
  preview: DropPreview | null
  colWidth: number
  rowPx?: number
}

export function DropZoneOverlay({ preview, colWidth: cw, rowPx = ROW_PX }: Props) {
  if (!preview || cw <= 0) return null
  const rect = rectToPixels(preview.rect, cw, rowPx)
  return (
    <div
      className="workspace-drop-zone pointer-events-none absolute z-30 rounded-xl"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
    />
  )
}
