import type { WidgetType } from "../types"

export interface WidgetSizeDefaults {
  w: number
  h: number
  minW: number
  minH: number
}

/** Defaults prefer full-canvas placement; `placeNewTile` uses viewport rows for height. */
export const WIDGET_DEFAULTS: Record<WidgetType, WidgetSizeDefaults> = {
  "thread-nav":      { w: 12, h: 24, minW: 2, minH: 4 },
  "agent-chat":      { w: 12, h: 24, minW: 2, minH: 2 },
  "term-chat":       { w: 12, h: 24, minW: 2, minH: 2 },
  "run-status":      { w: 12, h: 24, minW: 2, minH: 2 },
  "live-logs":       { w: 12, h: 24, minW: 4, minH: 2 },
  "step-timeline":   { w: 12, h: 24, minW: 2, minH: 2 },
  "run-history":     { w: 12, h: 24, minW: 2, minH: 2 },
  "debug-inspector": { w: 12, h: 24, minW: 2, minH: 2 },
  "mymi-db":         { w: 12, h: 24, minW: 2, minH: 2 },
  "active-users":    { w: 12, h: 24, minW: 2, minH: 2 },
  "env-sync":        { w: 12, h: 24, minW: 4, minH: 4 },
  "operation-log":   { w: 12, h: 24, minW: 4, minH: 4 },
  "entity-registry": { w: 12, h: 24, minW: 6, minH: 6 },
  "sync-proposals":  { w: 12, h: 24, minW: 6, minH: 6 },
  "sync-approvals":  { w: 12, h: 24, minW: 6, minH: 6 },
  "sync-evidence":   { w: 12, h: 24, minW: 6, minH: 6 },
  "sync-admin":      { w: 12, h: 24, minW: 6, minH: 6 },
  "bridge":          { w: 12, h: 24, minW: 6, minH: 6 },
}
