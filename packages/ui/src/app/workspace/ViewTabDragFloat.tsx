/**
 * Chrome-like drag preview — the tab itself sliding on the strip, not a card.
 */

import type { JSX } from "react"
import type { ViewTabFloat } from "../../hooks/useViewTabReorder"

type Props = {
  float: ViewTabFloat
}

export function ViewTabDragFloat({ float }: Props): JSX.Element {
  return (
    <div
      className={[
        "view-tab view-tab--float",
        float.wasActive ? "view-tab--active" : "view-tab--inactive",
      ].join(" ")}
      style={{
        left: float.left,
        width: Math.max(72, float.widthPx),
      }}
      aria-hidden
    >
      <span className="view-tab__label relative z-[2] truncate">{float.name}</span>
    </div>
  )
}
