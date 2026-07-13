import { ChevronRight, Filter, Search, X } from "lucide-react"
import type { ReactNode } from "react"
import type { OperationStatus } from "../../api"
import { statusColorClass } from "./tokens"

const KIND_TABS = [
  { id: "all" as const, label: "All" },
  { id: "agent" as const, label: "Agent" },
  { id: "sync" as const, label: "Sync" },
]

const STATUS_OPTIONS: OperationStatus[] = ["running", "success", "failed", "cancelled", "skipped"]

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
    <div className="shrink-0 border-b border-border-subtle bg-panel/40">
      <div className={`flex items-center gap-3 px-3 ${compact ? "flex-wrap py-2" : "h-10 py-0"}`}>
        <nav className="flex shrink-0 items-center gap-0.5" aria-label="Scope">
          {KIND_TABS.map((tab) => {
            const active = kindView === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setKindView(tab.id)}
                className={`rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-overlay-2 text-text"
                    : "text-text-muted hover:text-text hover:bg-overlay-1"
                }`}
              >
                {tab.label}
              </button>
            )
          })}
        </nav>

        <div className="relative min-w-0 flex-1">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search operations…"
            aria-busy={searchPending || undefined}
            className="h-8 w-full rounded-md border border-border-subtle bg-canvas/60 pl-8 pr-8 text-[13px] text-text placeholder:text-text-faint focus:border-border-focus focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-faint hover:text-text"
            >
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!compact && (
            <div className="flex items-center gap-1">
              {STATUS_OPTIONS.map((s) => {
                const on = statuses.has(s)
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleStatus(s)}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize transition-colors ${
                      on
                        ? `bg-overlay-2 ${statusColorClass(s)}`
                        : "text-text-muted hover:bg-overlay-1 hover:text-text"
                    }`}
                  >
                    {s}
                  </button>
                )
              })}
              {statuses.size > 0 && (
                <button
                  type="button"
                  onClick={clearStatuses}
                  className="rounded p-1 text-text-faint hover:text-text"
                  title="Clear status filters"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}
          {compact && statuses.size > 0 && (
            <button
              type="button"
              onClick={clearStatuses}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-text-muted hover:bg-overlay-1"
            >
              <Filter size={12} />
              {statuses.size} filter{statuses.size === 1 ? "" : "s"}
            </button>
          )}
          <span className="hidden text-[12px] text-text-faint sm:inline">
            {filteredCount === totalCount ? filteredCount : `${filteredCount} / ${totalCount}`}
          </span>
        </div>
      </div>
    </div>
  )
}

export function DaySection({
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
    <section>
      <button
        type="button"
        onClick={onToggle}
        className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-border-subtle bg-canvas/95 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-text-muted backdrop-blur-sm hover:text-text-secondary"
      >
        <ChevronRight size={12} className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
        {label}
        <span className="font-normal normal-case tracking-normal text-text-faint">{count}</span>
      </button>
      {!collapsed && children}
    </section>
  )
}
