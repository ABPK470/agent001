/**
 * MobileNav — bottom navigation bar for switching widgets on mobile.
 *
 * Shows an icon for each widget in the active view.
 * Highlights the currently visible widget.
 */

import {
    Activity,
    ArrowLeftRight,
    BarChart3,
    Bug,
    Clock,
    Database,
    GitBranch,
    History,
    LayoutDashboard,
    MessageSquare,
    Plus,
    ScrollText,
    Shield,
    Users,
} from "lucide-react"
import type { ComponentType } from "react"
import type { Widget, WidgetType } from "../types"

const WIDGET_ICONS: Record<WidgetType, ComponentType<{ size?: number; className?: string }>> = {
  "term-chat": MessageSquare,
  "agent-chat": MessageSquare,
  "agent-viz": GitBranch,
  "run-status": Activity,
  "live-logs": ScrollText,
  "audit-trail": Shield,
  "step-timeline": Clock,
  "tool-stats": BarChart3,
  "run-history": History,
  "operator-env": LayoutDashboard,
  "debug-inspector": Bug,
  "mymi-db": Database,
  "active-users": Users,
  "env-sync": ArrowLeftRight,
  "operation-log": History,
}

const WIDGET_SHORT_LABELS: Record<WidgetType, string> = {
  "term-chat": "MI:A",
  "agent-chat": "Chat",
  "agent-viz": "Graph",
  "run-status": "Status",
  "live-logs": "Events",
  "audit-trail": "Audit",
  "step-timeline": "Steps",
  "tool-stats": "Stats",
  "run-history": "History",
  "operator-env": "IOE",
  "debug-inspector": "Trace",
  "mymi-db": "MyMI",
  "active-users": "Users",
  "env-sync": "Sync",
  "operation-log": "Pipelines",
}

interface Props {
  widgets: Widget[]
  activeIndex: number
  onChange: (index: number) => void
  onAdd: () => void
}

export function MobileNav({ widgets, activeIndex, onChange, onAdd }: Props) {
  return (
    <nav className="flex items-stretch bg-surface border-t border-border shrink-0 safe-area-bottom">
      {widgets.map((widget, i) => {
        const Icon = WIDGET_ICONS[widget.type] ?? LayoutDashboard
        const label = WIDGET_SHORT_LABELS[widget.type] ?? "Widget"
        const isActive = i === activeIndex
        return (
          <button
            key={widget.id}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] transition-colors ${
              isActive
                ? "text-accent"
                : "text-text-muted active:text-text-secondary"
            }`}
            onClick={() => onChange(i)}
          >
            <Icon size={20} />
            <span className="text-[10px] leading-tight">
              {label}
            </span>
          </button>
        )
      })}
      <button
        className="flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] text-text-muted active:text-text-secondary transition-colors"
        onClick={onAdd}
      >
        <Plus size={20} />
        <span className="text-[10px] leading-tight">Add</span>
      </button>
    </nav>
  )
}
