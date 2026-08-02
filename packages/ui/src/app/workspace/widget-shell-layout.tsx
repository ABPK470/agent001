/**
 * Shared widget body wrapping — tiles and modals use the same panel dialect.
 */

import type { ReactNode } from "react"
import type { WidgetLayout } from "./widget-definitions"

export function panelClassForLayout(layout: WidgetLayout): string {
  if (layout === "canvas") return "widget-panel widget-panel--canvas"
  return "widget-panel"
}

export function wrapWidgetBody(layout: WidgetLayout, children: ReactNode): ReactNode {
  if (layout === "split") return children
  return <div className={panelClassForLayout(layout)}>{children}</div>
}
