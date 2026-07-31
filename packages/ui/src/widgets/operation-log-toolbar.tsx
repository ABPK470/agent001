/**
 * Pipelines toolbar — same review dialect as Event Stream:
 *   leading empty | search | count · filter sheet
 * Kind + Status live in FilterSheet (multi-select), not leading chips.
 * No expand/collapse toggle — row chevrons own that.
 */

import { SlidersHorizontal } from "lucide-react"
import { useMemo, useRef, useState, type JSX } from "react"
import type { OperationStatus } from "../client/index"
import {
  ActiveFilterChips,
  FilterChoiceGrid,
  FilterField,
  FilterSheet,
  type ActiveFilterChipModel,
} from "../components/FilterSheet"
import {
  WidgetToolbar,
  WidgetToolbarCount,
  WidgetToolbarLeading,
  WidgetToolbarSearch,
  WidgetToolbarTrailing,
} from "./widget-toolbar"

export type PipelineKindFilter = "agent" | "sync" | "bridge"

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

export function OperationLogToolbar({
  kinds,
  setKinds,
  statuses,
  setStatuses,
  search,
  setSearch,
  searchPending,
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
  tiny: boolean
  filteredCount: number
  totalCount: number
}): JSX.Element {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filterBtnRef = useRef<HTMLButtonElement>(null)

  const filtersActive = kinds.size > 0 || statuses.size > 0
  const activeFilterCount = kinds.size + statuses.size

  const activeChips = useMemo((): ActiveFilterChipModel[] => {
    const chips: ActiveFilterChipModel[] = []
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
  }, [kinds, statuses, setKinds, setStatuses])

  function clearAllFilters(): void {
    setKinds(new Set())
    setStatuses(new Set())
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
            className={`widget-toolbar__icon-btn relative ${
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
              <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-text px-0.5 text-[9px] font-mono font-medium leading-none text-text-on-accent">
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
