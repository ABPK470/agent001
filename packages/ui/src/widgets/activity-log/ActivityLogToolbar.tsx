import { ChevronRight, Search, X } from "lucide-react"
import type { ReactNode } from "react"
import type { OperationStatus } from "../../api"
import { statusSoftBgClass, statusTextClass } from "../../operation-log-row"

const TABS = [
  { id: "all" as const, label: "All issues" },
  { id: "agent" as const, label: "Agent" },
  { id: "sync" as const, label: "Sync" },
]

const STATUSES: OperationStatus[] = ["running", "success", "failed", "cancelled", "skipped"]

export function ActivityLogToolbar({
  kindView,
  setKindView,
  statuses,
  toggleStatus,
  clearStatuses,
  search,
  setSearch,
  searchPending,
  filteredCount,
  totalCount,
  compact,
}: {
  kindView: "all" | "agent" | "sync"
  setKindView: (v: "all" | "agent" | "sync") => void
  statuses: Set<OperationStatus>
  toggleStatus: (s: OperationStatus) => void
  clearStatuses: () => void
  search: string
  setSearch: (v: string) => void
  searchPending: boolean
  filteredCount: number
  totalCount: number
  compact: boolean
}) {
  return (
    <header className="shrink-0 border-b border-border-subtle px-4 py-3">
      <div className={`flex items-center gap-4 ${compact ? "flex-wrap" : ""}`}>
        <div className="flex shrink-0 items-center gap-1 border-b border-transparent">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setKindView(tab.id)}
              className={`border-b-2 px-2 pb-2 text-sm font-medium transition-colors ${
                kindView === tab.id
                  ? "border-accent text-text-muted"
                  : "border-transparent text-text-faint hover:text-text-muted"
              }`}
            >
              {compact && tab.id === "all" ? "All" : tab.label}
            </button>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter…"
            aria-busy={searchPending || undefined}
            className="h-9 w-full max-w-md rounded-lg border border-border-subtle bg-panel/50 pl-9 pr-9 text-sm text-text-muted placeholder:text-text-faint focus:border-border focus:outline-none"
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-text-faint hover:text-text-muted">
              <X size={15} />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!compact &&
            STATUSES.map((s) => {
              const on = statuses.has(s)
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleStatus(s)}
                  className={`rounded-md px-2 py-1 text-sm capitalize transition-colors ${
                    on ? `${statusSoftBgClass(s)} ${statusTextClass(s)}` : "text-text-faint hover:text-text-muted hover:bg-overlay-1"
                  }`}
                >
                  {s}
                </button>
              )
            })}
          {statuses.size > 0 && (
            <button type="button" onClick={clearStatuses} className="text-text-faint hover:text-text-muted" title="Clear filters">
              <X size={15} />
            </button>
          )}
          <span className="text-sm text-text-faint">{filteredCount === totalCount ? filteredCount : `${filteredCount}/${totalCount}`}</span>
        </div>
      </div>
    </header>
  )
}

export function DayGroup({
  label,
  count,
  collapsed,
  onToggle,
  children,
}: {
  label: string
  count: number
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-text-faint hover:text-text-muted"
      >
        <ChevronRight size={14} className={collapsed ? "" : "rotate-90"} />
        {label}
        <span className="font-normal normal-case tracking-normal">{count}</span>
      </button>
      {!collapsed && children}
    </div>
  )
}
