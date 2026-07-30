/**
 * Per-tile identity for layout surfaces (survive remount across layout switches).
 */

import { createContext, useContext } from "react"
import type { WidgetType } from "../../types"

export type WidgetInstance = {
  widgetId: string
  viewId: string
  type: WidgetType
}

const WidgetInstanceContext = createContext<WidgetInstance | null>(null)

export const WidgetInstanceProvider = WidgetInstanceContext.Provider

export function useWidgetInstance(): WidgetInstance | null {
  return useContext(WidgetInstanceContext)
}
