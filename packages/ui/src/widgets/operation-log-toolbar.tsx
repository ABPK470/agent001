/**
 * Pipelines toolbar — same review dialect as Event Stream:
 *   leading empty | search | count · filter sheet
 * Kind + Status + Quick range + From/Until in FilterSheet.
 */

import { SlidersHorizontal } from "lucide-react"
import { useMemo, useRef, useState, type JSX } from "react"
import type { OperationStatus } from "../client/index"
import { DateField } from "../components/DateField"
import {
  ActiveFilterChips,
  FilterChoiceGrid,
  FilterField,
  FilterSheet,
  type ActiveFilterChipModel,
} from "../components/FilterSheet"
import type { PipelineKindFilter } from "../lib/operation-log-prefs"
import type { EventStreamRange, EventStreamWindow } from "../lib/event-stream-prefs"
import {
  WidgetToolbar,
  WidgetToolbarCount,
  WidgetToolbarLeading,
  WidgetToolbarSearch,
  WidgetToolbarTrailing,
} from "./widget-toolbar"

export type { PipelineKindFilter }

const KIND_OPTIONS: readonly { value: PipelineKindFilter; label: string }[] = [
  { value: "agent", label: "Agent" },
  { value: "sync", label: "Sync" },
  { value: "bridge", label: "Bridge" },
]

const STATUS_OPTIONS: readonly { value: OperationStatus; label: string }[] = [
  { value: "running", label: "Running" },
  { value: "success", label: "Success" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "skipped", label: "Skipped" },
]

const QUICK_RANGES: { id: EventStreamRange; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "15m", label: "15m" },
  { id: "1h", label: "1h" },
  { id: "6h", label: "6h" },
  { id: "24h", label: "24h" },
]

export function OperationLogToolbar({
  kinds,
  setKinds,
  statuses,
  setStatuses,
  search,
  setSearch,
  searchPending,
  timeWindow,
  setQuickRange,
  setFromDate,
  setToDate,
  tiny,
  filteredCount,
  totalCount,
}: {
  kinds: Set<PipelineKindFilter>
  setKinds: (next: Set<PipelineKindFilter>) => void
  statuses: Set<OperationStatus>
  setStatuses: (next: Set<OperationStatus>) => void
  search: string
  setSearch: (v: string) => void
  searchPending: boolean
  timeWindow: EventStreamWindow
  setQuickRange: (range: EventStreamRange) => void
  setFromDate: (from: string | undefined) => void
  setToDate: (to: string | undefined) => void
  tiny: boolean
  filteredCount: number
  totalCount: number
}): JSX.Element {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filterBtnRef = useRef<HTMLButtonElement>(null)

  const hasCustomDates = Boolean(timeWindow.from || timeWindow.to)
  const timeFiltered = hasCustomDates || timeWindow.range !== "live"
  const filtersActive = kinds.size > 0 || statuses.size > 0 || timeFiltered
  const activeFilterCount =
    kinds.size +
    statuses.size +
    (hasCustomDates
      ? (timeWindow.from ? 1 : 0) + (timeWindow.to ? 1 : 0)
      : timeFiltered
        ? 1
        : 0)

  const activeChips = useMemo((): ActiveFilterChipModel[] => {
    const chips: ActiveFilterChipModel[] = []
    if (hasCustomDates) {
      if (timeWindow.from) {
        chips.push({
          id: "from",
          label: "From",
          value: timeWindow.from,
          onRemove: () => setFromDate(undefined),
        })
      }
      if (timeWindow.to) {
        chips.push({
          id: "until",
          label: "Until",
          value: timeWindow.to,
          onRemove: () => setToDate(undefined),
        })
      }
    } else if (timeWindow.range !== "live") {
      chips.push({
        id: "range",
        label: "Range",
        value: timeWindow.range,
        onRemove: () => setQuickRange("live"),
      })
    }
    for (const kind of kinds) {
      chips.push({
        id: `kind:${kind}`,
        label: "Kind",
        value: kind,
        onRemove: () => {
          const next = new Set(kinds)
          next.delete(kind)
          setKinds(next)
        },
      })
    }
    for (const status of statuses) {
      chips.push({
        id: `status:${status}`,
        label: "Status",
        value: status,
        onRemove: () => {
          const next = new Set(statuses)
          next.delete(status)
          setStatuses(next)
        },
      })
    }
    return chips
  }, [
    kinds,
    statuses,
    hasCustomDates,
    timeWindow.from,
    timeWindow.to,
    timeWindow.range,
    setKinds,
    setStatuses,
    setFromDate,
    setToDate,
    setQuickRange,
  ])

  function clearAllFilters(): void {
    setKinds(new Set())
    setStatuses(new Set())
    setQuickRange("live")
    setFromDate(undefined)
    setToDate(undefined)
  }

  function onQuickRange(range: EventStreamRange): void {
    setFromDate(undefined)
    setToDate(undefined)
    setQuickRange(range)
  }

  return (
    <>
      <WidgetToolbar>
        <WidgetToolbarLeading>{null}</WidgetToolbarLeading>
        <WidgetToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter pipelines…"
          loading={searchPending}
          onClear={() => setSearch("")}
        />
        <WidgetToolbarTrailing>
          <WidgetToolbarCount filtered={filteredCount} total={totalCount} hidden={tiny} />
          <button
            ref={filterBtnRef}
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`widget-toolbar__icon-btn ${
              filtersOpen || filtersActive ? "widget-toolbar__icon-btn--active" : ""
            }`}
            title={
              filtersActive
                ? `Filters (${activeFilterCount} active)`
                : "Filters"
            }
            aria-pressed={filtersOpen || filtersActive}
          >
            <SlidersHorizontal size={14} strokeWidth={1.75} />
            {filtersActive && (
              <span className="widget-toolbar__icon-badge" aria-hidden>
                {activeFilterCount > 9 ? "9+" : activeFilterCount}
              </span>
            )}
          </button>
        </WidgetToolbarTrailing>
      </WidgetToolbar>

      <ActiveFilterChips
        chips={activeChips}
        onClear={activeFilterCount > 0 ? clearAllFilters : undefined}
      />

      <FilterSheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        anchorRef={filterBtnRef}
        footer={
          filtersActive ? (
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-sm font-medium text-text-muted hover:text-text"
            >
              Clear all
            </button>
          ) : null
        }
      >
        <FilterField label="Quick range">
          <FilterChoiceGrid
            options={QUICK_RANGES.map((r) => ({ value: r.id, label: r.label }))}
            values={hasCustomDates ? [] : [timeWindow.range]}
            onChange={(values) => {
              const next = values[0]
              if (next) onQuickRange(next)
            }}
            columns={3}
            mode="single"
          />
        </FilterField>
        <div className="grid grid-cols-2 gap-3">
          <FilterField label="From">
            <DateField
              value={timeWindow.from}
              onChange={(from) => setFromDate(from || undefined)}
              placeholder="Pick date"
              ariaLabel="From"
              size="sm"
              className="w-full"
            />
          </FilterField>
          <FilterField label="Until">
            <DateField
              value={timeWindow.to}
              onChange={(to) => setToDate(to || undefined)}
              placeholder="Pick date"
              ariaLabel="Until"
              size="sm"
              className="w-full"
            />
          </FilterField>
        </div>
        <FilterField label="Kind">
          <FilterChoiceGrid
            options={KIND_OPTIONS}
            values={[...kinds]}
            onChange={(values) => setKinds(new Set(values))}
            columns={3}
            mode="multi"
          />
        </FilterField>
        <FilterField label="Status">
          <FilterChoiceGrid
            options={STATUS_OPTIONS}
            values={[...statuses]}
            onChange={(values) => setStatuses(new Set(values))}
            columns={3}
            mode="multi"
          />
        </FilterField>
      </FilterSheet>
    </>
  )
}
