/**
 * Destination preview while dragging a tile.
 * Layout stays frozen — this ghost shows where the panel will land, looking
 * like the real shell (not an accent pill).
 */

import { GripVertical } from "lucide-react"
import type { JSX } from "react"
import { rectToPixels, ROW_PX } from "../../../lib/grid-math"
import type { WidgetType } from "../../../types"
import { getWidgetDefinition } from "../widget-definitions"
import type { DropPreview } from "./useGridInteraction"

interface Props {
  preview: DropPreview | null
  widgetType: WidgetType | null
  colWidth: number
  rowPx?: number
}

export function DropZoneOverlay({
  preview,
  widgetType,
  colWidth: cw,
  rowPx = ROW_PX,
}: Props): JSX.Element | null {
  if (!preview || cw <= 0 || !widgetType) return null
  const rect = rectToPixels(preview.rect, cw, rowPx)
  const label = getWidgetDefinition(widgetType).label

  return (
    <div
      className="workspace-drop-ghost pointer-events-none absolute z-30 overflow-hidden rounded-xl"
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }}
      aria-hidden
    >
      <div className="workspace-drop-ghost__shell flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center gap-1.5 px-2.5">
          <GripVertical size={16} className="shrink-0 text-text-faint" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wider text-text-muted">
            {label}
          </span>
        </div>
        <div className="workspace-drop-ghost__body min-h-0 flex-1" />
      </div>
    </div>
  )
}
