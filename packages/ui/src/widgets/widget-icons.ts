/**
 * Canonical Lucide icons per widget — used in WidgetCatalog, WidgetModal, and
 * widget empty states so the same glyph appears everywhere for a panel type.
 */

import {
  ArrowRightLeft,
  AudioWaveform,
  Bug,
  Database,
  Info,
  ListTree,
  Logs,
  MessageSquare,
  Settings,
  Ship,
  TableProperties,
  Users,
  type LucideIcon,
} from "lucide-react"

import type { WidgetType } from "../types"

export const WIDGET_ICONS: Record<WidgetType, LucideIcon> = {
  "thread-nav": AudioWaveform,
  "term-chat": MessageSquare,
  "env-sync": Ship,
  "mymi-db": Database,
  "operation-log": ListTree,
  "live-logs": Logs,
  "run-status": Info,
  "debug-inspector": Bug,
  "active-users": Users,
  "entity-registry": TableProperties,
  "sync-proposals": Settings,
  "sync-approvals": Settings,
  "sync-evidence": Settings,
  "sync-admin": Settings,
  "bridge": ArrowRightLeft,
}

export function widgetIcon(type: WidgetType): LucideIcon {
  return WIDGET_ICONS[type]
}
