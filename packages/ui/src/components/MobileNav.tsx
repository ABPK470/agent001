/**
 * MobileNav — bottom navigation bar for switching widgets on mobile.
 *
 * Shows an icon for each widget in the active view.
 * Highlights the currently visible widget.
 */

import {
    Activity,
    BarChart3,
    Clock,
    GitBranch,
    History,
    LayoutGrid,
    ListTree,
    MessageSquare,
    Plus,
    ScrollText,
    Shield,
} from "lucide-react";
import type { ComponentType } from "react";
import type { Widget, WidgetType } from "../types";

const WIDGET_ICONS: Record<WidgetType, ComponentType<{ size?: number; className?: string }>> = {
  "agent-chat": MessageSquare,
  "agent-trace": ListTree,
  "agent-viz": GitBranch,
  "run-status": Activity,
  "live-logs": ScrollText,
  "audit-trail": Shield,
  "step-timeline": Clock,
  "tool-stats": BarChart3,
  "run-history": History,
  "command-center": LayoutGrid,
}

const WIDGET_SHORT_LABELS: Record<WidgetType, string> = {
  "agent-chat": "Chat",
  "agent-trace": "Trace",
  "agent-viz": "Graph",
  "run-status": "Status",
  "live-logs": "Events",
  "audit-trail": "Audit",
  "step-timeline": "Steps",
  "tool-stats": "Stats",
  "run-history": "History",
  "command-center": "Center",
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
        const Icon = WIDGET_ICONS[widget.type]
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
              {WIDGET_SHORT_LABELS[widget.type]}
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
