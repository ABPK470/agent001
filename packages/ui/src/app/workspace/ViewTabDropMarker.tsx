/**
 * In-flow insertion preview while reordering view tabs.
 * Takes real strip space so neighbors open a gap for the drop.
 * Looks like the dragged tab — not an accent pill / absolute overhang.
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
      className="view-tab-drop-ghost pointer-events-none flex h-9 shrink-0 items-center gap-1 rounded-lg px-2.5 text-[13px]"
      style={{ width: Math.max(72, widthPx) }}
      aria-hidden
    >
      <GripVertical size={12} className="shrink-0 text-text-faint" />
      <span className="truncate font-semibold text-text">{name}</span>
    </span>
  )
}
