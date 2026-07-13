import { Filter, X } from "lucide-react"
import type { OperationStatus } from "../api"
import { LogStatusLabel, statusSoftBgClass, statusTextClass } from "../operation-log-row"
import {
  LOG_TOOLBAR_CHIP,
  LOG_TOOLBAR_CHIP_ACTIVE,
  LOG_TOOLBAR_CHIP_IDLE,
  LOG_TOOLBAR_DIVIDER,
  LOG_TOOLBAR_ICON_BTN,
  LogWidgetToolbar,
  LogWidgetToolbarCount,
  LogWidgetToolbarFilters,
  LogWidgetToolbarSearch,
  LogWidgetToolbarTail,
} from "./widget-toolbar"

const ALL_STATUSES: OperationStatus[] = ["running", "success", "failed", "cancelled", "skipped"]

export function OperationLogToolbar({
  kindView,
  setKindView,
  statuses,
  toggleStatus,
  clearStatuses,
  search,
  setSearch,
  searchPending,
  compact,
  tiny,
  statusesOpen,
  setStatusesOpen,
  filteredCount,
  totalCount,
}: {
  kindView: "all" | "agent" | "sync"
  setKindView: (v: "all" | "agent" | "sync") => void
  statuses: Set<OperationStatus>
  toggleStatus: (s: OperationStatus) => void
  clearStatuses: () => void
  search: string
  setSearch: (v: string) => void
  searchPending: boolean
  compact: boolean
  tiny: boolean
  statusesOpen: boolean
  setStatusesOpen: (v: boolean | ((prev: boolean) => boolean)) => void
  filteredCount: number
  totalCount: number
}) {
  return (
    <LogWidgetToolbar compact={compact}>
      <LogWidgetToolbarFilters>
        {(["all", "agent", "sync"] as const).map((v) => {
          const active = v === kindView
          const label = v === "sync" ? (compact || tiny ? "sync" : "synchronization") : v
          return (
            <button
              key={v}
              onClick={() => setKindView(v)}
              className={`${LOG_TOOLBAR_CHIP} ${active ? LOG_TOOLBAR_CHIP_ACTIVE : LOG_TOOLBAR_CHIP_IDLE}`}
            >
              {label}
            </button>
          )
        })}

        {!compact && <div className={LOG_TOOLBAR_DIVIDER} aria-hidden />}

        {!compact ? (
          <>
            {ALL_STATUSES.map((s) => {
              const on = statuses.has(s)
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  className={`${LOG_TOOLBAR_CHIP} ${
                    on ? `${statusSoftBgClass(s)} ${statusTextClass(s)} font-medium` : LOG_TOOLBAR_CHIP_IDLE
                  }`}
                >
                  {s}
                </button>
              )
            })}
            {statuses.size > 0 && (
              <button
                onClick={clearStatuses}
                className={`${LOG_TOOLBAR_ICON_BTN} text-text-muted hover:text-text hover:bg-elevated/40`}
                title="Clear status filters"
              >
                <X size={14} />
              </button>
            )}
          </>
        ) : (
          <div className="relative shrink-0">
            <button
              onClick={() => setStatusesOpen((v) => !v)}
              className={`${LOG_TOOLBAR_CHIP} ${
                statuses.size > 0 ? LOG_TOOLBAR_CHIP_ACTIVE : LOG_TOOLBAR_CHIP_IDLE
              }`}
            >
              <Filter size={13} />
              {statuses.size === 0 ? "status" : `${statuses.size} status`}
            </button>
            {statusesOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setStatusesOpen(false)} />
                <div className="absolute left-0 top-full mt-1 z-50 bg-elevated border border-border rounded-md shadow-2xl py-1 min-w-[160px]">
                  {ALL_STATUSES.map((s) => {
                    const on = statuses.has(s)
                    return (
                      <button
                        key={s}
                        onClick={() => toggleStatus(s)}
                        className={`flex items-center justify-between gap-3 w-full text-left px-3 py-2 text-xs transition-colors ${
                          on
                            ? `${statusSoftBgClass(s)} ${statusTextClass(s)} font-medium`
                            : "text-text-muted hover:text-text hover:bg-overlay-2"
                        }`}
                      >
                        <LogStatusLabel status={s} compact />
                      </button>
                    )
                  })}
                  {statuses.size > 0 && (
                    <button
                      onClick={clearStatuses}
                      className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2 text-xs text-text-muted hover:text-text hover:bg-overlay-2"
                    >
                      <X size={12} />
                      Clear filters
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </LogWidgetToolbarFilters>

      <LogWidgetToolbarSearch
        value={search}
        onChange={setSearch}
        placeholder="Filter operations…"
        loading={searchPending}
        onClear={() => setSearch("")}
      />

      <LogWidgetToolbarTail>
        <LogWidgetToolbarCount filtered={filteredCount} total={totalCount} hidden={tiny} />
      </LogWidgetToolbarTail>
    </LogWidgetToolbar>
  )
}
