/**
 * Insertion caret between view tabs while reordering.
 * Absolutely positioned so it does not shift tab midpoints mid-drag.
 */

import type { JSX } from "react"

type Props = {
  /** `before` sits on the left edge of the following tab; `after` on the right of the strip. */
  edge?: "before" | "after"
}

export function ViewTabDropMarker({ edge = "before" }: Props): JSX.Element {
  const side = edge === "after" ? "left-0" : "-left-1"
  return (
    <span
      className={`pointer-events-none absolute ${side} top-1 bottom-1 z-20 flex w-1.5 items-stretch`}
      aria-hidden
    >
      <span className="w-full rounded-full bg-accent shadow-[0_0_0_3px_var(--color-accent-soft)]" />
    </span>
  )
}
