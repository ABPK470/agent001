/**
 * MobileNav — bottom navigation bar for switching layouts on mobile.
 *
 * Shows one tab per layout so the full set is reachable from a narrow
 * viewport. The strip scrolls horizontally when there are too many to fit.
 * A trailing "Add" button creates a new layout.
 */

import { LayoutDashboard, Plus } from "lucide-react"
import type { WorkspaceView } from "../../lib/workspace-view"

interface Props {
  views: WorkspaceView[]
  activeViewId: string
  onSelectView: (id: string) => void
  onAdd: () => void
}

export function MobileNav({ views, activeViewId, onSelectView, onAdd }: Props) {
  return (
    <nav className="flex items-stretch bg-surface border-t border-border shrink-0 safe-area-bottom">
      <div className="flex-1 flex items-stretch overflow-x-auto scrollbar-none">
        {views.map((view) => {
          const isActive = view.id === activeViewId
          return (
            <button
              key={view.id}
              className={`shrink-0 min-w-[64px] flex flex-col items-center justify-center gap-0.5 px-3 py-2 min-h-[56px] transition-colors ${
                isActive
                  ? "text-text font-medium bg-[var(--select-fill)]"
                  : "text-text-muted hover:bg-[var(--hover-fill)] hover:text-text active:bg-[var(--hover-fill)]"
              }`}
              onClick={() => onSelectView(view.id)}
            >
              <LayoutDashboard size={20} />
              <span className="text-[10px] leading-tight max-w-[72px] truncate">
                {view.name}
              </span>
            </button>
          )
        })}
      </div>
      <button
        className="shrink-0 min-w-[64px] flex flex-col items-center justify-center gap-0.5 px-3 py-2 min-h-[56px] text-text-muted active:text-text-secondary transition-colors border-l border-border-subtle"
        onClick={onAdd}
      >
        <Plus size={20} />
        <span className="text-[10px] leading-tight">Add</span>
      </button>
    </nav>
  )
}
