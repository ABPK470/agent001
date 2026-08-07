/**
 * Active Users zen HUD — compact stats, search, filters, exit.
 * Shell chrome is hidden in zen; this is the only way out besides Z / Esc.
 *
 * Stats expand inline (not an absolute popover) so the panel pushes the
 * table down instead of painting over sticky headers.
 */

import { ChevronDown, Info, Search, SlidersHorizontal, X } from "lucide-react"
import { useEffect, useRef, type RefObject } from "react"
import { ZenSessionHudActions } from "../components/ZenSessionHudActions"
import { formatModChord } from "../lib/keymap"
import { useLayoutStore } from "../state/layout-store"
import { WidgetToolbarCount } from "./widget-toolbar"

type ZenStat = { value: string; label: string }

export function ActiveUsersZenHud({
  stats,
  filter,
  onFilterChange,
  searchOpen,
  onSearchOpenChange,
  statsOpen,
  onStatsOpenChange,
  filteredCount,
  totalCount,
  filtersActive,
  activeFilterCount,
  onOpenFilters,
  filterBtnRef,
  onExitZen,
}: {
  stats: ZenStat[]
  filter: string
  onFilterChange: (value: string) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  statsOpen: boolean
  onStatsOpenChange: (open: boolean) => void
  filteredCount: number
  totalCount: number
  filtersActive: boolean
  activeFilterCount: number
  onOpenFilters: () => void
  filterBtnRef: RefObject<HTMLButtonElement | null>
  onExitZen: () => void
}) {
  const saveZenSpace = useLayoutStore((s) => s.saveZenSpace)
  const searchRef = useRef<HTMLInputElement>(null)
  const statsPanelRef = useRef<HTMLDivElement>(null)
  const statsBadgeRef = useRef<HTMLButtonElement>(null)

  const compactStats = stats.map((stat) => `${stat.value} ${stat.label}`).join(" · ")

  useEffect(() => {
    if (!searchOpen) return
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [searchOpen])

  useEffect(() => {
    if (!statsOpen) return
    function onPointerDown(event: MouseEvent) {
      const target = event.target
      if (!(target instanceof Node)) return
      if (statsBadgeRef.current?.contains(target)) return
      if (statsPanelRef.current?.contains(target)) return
      onStatsOpenChange(false)
    }
    document.addEventListener("mousedown", onPointerDown)
    return () => document.removeEventListener("mousedown", onPointerDown)
  }, [onStatsOpenChange, statsOpen])

  function onDismissSearch() {
    if (filter) onFilterChange("")
    else onSearchOpenChange(false)
  }

  return (
    <div className="trace-zen-hud au-zen-hud">
      <div className="au-zen-hud__row">
        {searchOpen ? (
          <div className="trace-zen-hud__search-inline au-zen-hud__search" role="search">
            <Search size={14} className="trace-zen-hud__search-icon" aria-hidden />
            <input
              ref={searchRef}
              type="text"
              className="trace-zen-hud__search-input"
              value={filter}
              placeholder="Filter by name, UPN, IP, model…"
              aria-label="Filter users"
              onChange={(event) => onFilterChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  onDismissSearch()
                }
              }}
            />
            <button
              type="button"
              className="trace-zen-hud__search-clear"
              aria-label={filter ? "Clear filter" : "Close filter"}
              title={filter ? "Clear" : "Close filter (Esc)"}
              onClick={onDismissSearch}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <>
            <div className="trace-zen-hud__leading">
              {compactStats ? (
                <button
                  ref={statsBadgeRef}
                  type="button"
                  className="trace-zen-hud__stats-badge tabular-nums"
                  aria-expanded={statsOpen}
                  aria-controls="au-zen-stats-panel"
                  onClick={() => onStatsOpenChange(!statsOpen)}
                >
                  <span className="trace-zen-hud__stats-text">{compactStats}</span>
                  <span className="trace-zen-hud__stats-trigger" aria-hidden>
                    <Info size={11} strokeWidth={2.25} />
                    <ChevronDown
                      size={12}
                      className={`trace-zen-hud__stats-chev${statsOpen ? " is-open" : ""}`}
                    />
                  </span>
                </button>
              ) : null}
              <span className="trace-zen-hud__hint text-text-muted tabular-nums" aria-hidden>
                <WidgetToolbarCount filtered={filteredCount} total={totalCount} compact />
              </span>
            </div>

            <div className="trace-zen-hud__trailing">
              <button
                type="button"
                className="trace-zen-hud__icon-btn"
                title={`Filter (${formatModChord("F")} or /)`}
                aria-label="Filter users"
                onClick={() => onSearchOpenChange(true)}
              >
                <Search size={14} />
              </button>

              <button
                ref={filterBtnRef}
                type="button"
                className={`trace-zen-hud__icon-btn${filtersActive ? " is-active" : ""}`}
                title={filtersActive ? `Filters (${activeFilterCount} active)` : "Filters"}
                aria-label="Filters"
                aria-pressed={filtersActive}
                onClick={onOpenFilters}
              >
                <SlidersHorizontal size={14} />
              </button>

              <ZenSessionHudActions
                onExitZen={onExitZen}
                onSaveZen={() => {
                  saveZenSpace()
                }}
              />
            </div>
          </>
        )}
      </div>

      {statsOpen && !searchOpen ? (
        <div
          ref={statsPanelRef}
          id="au-zen-stats-panel"
          className="au-zen-hud__stats-panel"
          role="region"
          aria-label="User stats"
        >
          <div className="trace-zen-hud__stats-grid">
            {stats.map((stat) => (
              <span key={stat.label} className="trace-zen-hud__stat">
                <span className="trace-zen-hud__stat-value tabular-nums">{stat.value}</span>
                <span className="trace-zen-hud__stat-label">{stat.label}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
