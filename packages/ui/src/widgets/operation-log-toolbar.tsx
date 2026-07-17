import { Check, Filter, X } from "lucide-react"
import type { OperationStatus } from "../client/index"
import { statusFilterActiveClass } from "./pipelines/operation-log-row"
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

function StatusFilterChip({
  status,
  active,
  onClick,
}: {
  status: OperationStatus
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`${LOG_TOOLBAR_CHIP} capitalize ${
        active ? statusFilterActiveClass(status) : LOG_TOOLBAR_CHIP_IDLE
      }`}
    >
      {status}
    </button>
  )
}

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
  kindView: "all" | "agent" | "sync" | "bridge"
  setKindView: (v: "all" | "agent" | "sync" | "bridge") => void
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
        {(["all", "agent", "sync", "bridge"] as const).map((v) => {
          const active = v === kindView
          const label =
            v === "sync" ? (compact || tiny ? "sync" : "synchronization") : v
          return (
            <button
              key={v}
              type="button"
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
            {ALL_STATUSES.map((s) => (
              <StatusFilterChip
                key={s}
                status={s}
                active={statuses.has(s)}
                onClick={() => toggleStatus(s)}
              />
            ))}
            {statuses.size > 0 && (
              <button
                type="button"
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
              type="button"
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
                <div className="absolute left-0 top-full z-50 mt-1 min-w-[168px] rounded-md border border-border bg-elevated py-1 shadow-2xl">
                  {ALL_STATUSES.map((s) => {
                    const on = statuses.has(s)
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => toggleStatus(s)}
                        aria-pressed={on}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm capitalize transition-colors ${
                          on
                            ? statusFilterActiveClass(s)
                            : "text-text-muted hover:bg-overlay-2 hover:text-text"
                        }`}
                      >
                        <Check
                          size={14}
                          className={`shrink-0 ${on ? "opacity-100" : "opacity-0"}`}
                          aria-hidden
                        />
                        {s}
                      </button>
                    )
                  })}
                  {statuses.size > 0 && (
                    <button
                      type="button"
                      onClick={clearStatuses}
                      className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2 text-sm text-text-muted hover:bg-overlay-2 hover:text-text"
                    >
                      <X size={14} />
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
