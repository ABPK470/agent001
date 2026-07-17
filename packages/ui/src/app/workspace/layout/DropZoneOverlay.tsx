import { rectToPixels, ROW_PX } from "../../../lib/grid-math"
import type { GridRect } from "../../../lib/grid-math"

interface Props {
  candidate: GridRect | null
  colWidth: number
  rowPx?: number
}

export function DropZoneOverlay({ candidate, colWidth: cw, rowPx = ROW_PX }: Props) {
  if (!candidate || cw <= 0) return null
  const rect = rectToPixels(candidate, cw, rowPx)
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
