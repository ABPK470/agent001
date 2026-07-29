/**
 * Chrome-like drag preview — same chrome as a resting tab (grip + label + close)
 * so the label does not jump left inside the measured width.
 */

import { GripVertical, X } from "lucide-react"
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
      <GripVertical
        size={12}
        className="view-tab__grip relative z-[2] shrink-0"
      />
      <span className="view-tab__label relative z-[2] whitespace-nowrap">{float.name}</span>
      {float.showClose ? (
        <span className="view-tab__close relative z-[2]">
          <X size={14} />
        </span>
      ) : null}
    </div>
  )
}
