/**
 * Insertion slot between view tabs while reordering.
 * Absolutely positioned so tab midpoints stay stable mid-drag.
 * Strip adds left padding while dragging so the first-slot marker is not clipped.
 */

import type { JSX } from "react"

type Props = {
  /** `before` sits on the left edge of the following tab; `after` on the right of the strip. */
  edge?: "before" | "after"
}

export function ViewTabDropMarker({ edge = "before" }: Props): JSX.Element {
  const side = edge === "after" ? "left-0" : "left-0 -translate-x-1/2"
  return (
    <span
      className={`pointer-events-none absolute ${side} top-1/2 z-20 -translate-y-1/2`}
      aria-hidden
    >
      <span className="view-tab-drop-slot" />
    </span>
  )
}
