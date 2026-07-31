/**
 * Shared chrome for admin browse modals (Audit, Usage).
 * Same BrowseStrip dialect as Catalog versions / Sync History.
 */

import { ChevronLeft, ChevronRight, RefreshCw, SlidersHorizontal } from "lucide-react"
import type { ReactNode } from "react"
import {
  BrowseIconButton,
  BrowseSearchField,
  BrowseStrip,
  BrowseStripSearch,
  BrowseStripTrailing,
} from "../../components/BrowseStrip"

export function AdminBrowseFilterField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-faint">
        {label}
      </span>
      {children}
    </label>
  )
}

export function AdminBrowseToolbar({
  search,
  onSearchChange,
  searchPlaceholder,
  searchAriaLabel,
  filtersOpen,
  onToggleFilters,
  activeFilterCount,
  onRefresh,
  loading,
  trailing,
}: {
  search: string
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  searchAriaLabel: string
  filtersOpen: boolean
  onToggleFilters: () => void
  activeFilterCount: number
  onRefresh: () => void
  loading: boolean
  trailing?: ReactNode
}) {
  return (
    <BrowseStrip>
      <BrowseStripSearch>
        <BrowseSearchField
          value={search}
          onChange={onSearchChange}
          placeholder={searchPlaceholder}
          aria-label={searchAriaLabel}
        />
      </BrowseStripSearch>
      <BrowseStripTrailing>
        <BrowseIconButton
          active={filtersOpen || activeFilterCount > 0}
          badge={activeFilterCount > 0 ? activeFilterCount : null}
          onClick={onToggleFilters}
          title={activeFilterCount > 0 ? `Filters (${activeFilterCount} active)` : "Filters"}
          aria-pressed={filtersOpen}
        >
          <SlidersHorizontal size={15} />
        </BrowseIconButton>
        <BrowseIconButton onClick={onRefresh} title="Refresh">
          <RefreshCw size={15} className={loading ? "animate-spin" : undefined} />
        </BrowseIconButton>
        {trailing}
      </BrowseStripTrailing>
    </BrowseStrip>
  )
}

export function AdminBrowseFiltersPanel({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 space-y-3 border-b border-border-subtle bg-base/30 px-6 py-3">
      {children}
    </div>
  )
}

export function AdminBrowsePaginationFooter({
  loading,
  total,
  singular,
  plural,
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  loading: boolean
  total: number
  singular: string
  plural: string
  page: number
  totalPages: number
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <div className="flex w-full items-center justify-between gap-3">
      <span className="text-[13px] text-text-muted">
        {loading ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? singular : plural}`}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page <= 1 || loading}
          onClick={onPrev}
          className="rounded-lg p-1.5 text-text-muted hover:bg-overlay-hover hover:text-text disabled:opacity-30"
          aria-label="Previous page"
        >
          <ChevronLeft size={16} />
        </button>
        <span className="min-w-[5rem] text-center font-mono text-[12px] text-text-muted">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          disabled={page >= totalPages || loading}
          onClick={onNext}
          className="rounded-lg p-1.5 text-text-muted hover:bg-overlay-hover hover:text-text disabled:opacity-30"
          aria-label="Next page"
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}
