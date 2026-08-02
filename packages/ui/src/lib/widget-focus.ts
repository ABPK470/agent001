/**
 * Widgets that support zen / focus mode (edge-to-edge debugger surface).
 */

import type { WidgetType } from "../types"

const FOCUS_WIDGET_TYPES = new Set<WidgetType>([
  "debug-inspector",
  "active-users",
])

export function widgetSupportsFocusMode(type: WidgetType): boolean {
  return FOCUS_WIDGET_TYPES.has(type)
}
