/**
 * In-flow insertion preview while reordering view tabs.
 * Takes real strip space so neighbors open a gap for the drop.
 * Matches attached-tab chrome (not a flat chip).
 */

import { GripVertical } from "lucide-react"
import type { JSX } from "react"

type Props = {
  name: string
  /** Match the dragged tab’s width so the preview reads as the real chip. */
  widthPx: number
}

export function ViewTabDropMarker({ name, widthPx }: Props): JSX.Element {
  return (
    <span
      className="view-tab view-tab--active view-tab-drop-ghost pointer-events-none"
      style={{ width: Math.max(72, widthPx) }}
      aria-hidden
    >
      <GripVertical size={12} className="view-tab__grip shrink-0 opacity-70" />
      <span className="view-tab__label truncate">{name}</span>
    </span>
  )
}
