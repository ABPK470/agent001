/**
 * Active Users zen HUD — stats always on the strip (no collapsible pill).
 * Shell chrome is hidden in zen; search / filters / exit trail right.
 */

import { Search, SlidersHorizontal, X } from "lucide-react"
import { useEffect, useRef, type RefObject } from "react"
import { ZenSessionHudActions } from "../components/ZenSessionHudActions"
import { formatModChord } from "../lib/keymap"
import { isZenViewId } from "../lib/zen-session"
import { useLayoutStore } from "../state/layout-store"

type ZenStat = { value: string; label: string }

export function ActiveUsersZenHud({
  stats,
  filter,
  onFilterChange,
  searchOpen,
  onSearchOpenChange,
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
  filtersActive: boolean
  activeFilterCount: number
  onOpenFilters: () => void
  filterBtnRef: RefObject<HTMLButtonElement | null>
  onExitZen: () => void
}) {
  const saveZenSpace = useLayoutStore((s) => s.saveZenSpace)
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!searchOpen) return
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [searchOpen])

  function onDismissSearch() {
    if (filter) onFilterChange("")
    else onSearchOpenChange(false)
  }

  return (
    <div className="trace-zen-hud au-zen-hud">
      <div className="trace-zen-hud__bar">
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
            <div className="trace-zen-hud__leading" aria-label="User stats">
              <div className="trace-zen-hud__stats-grid au-zen-hud__stats-inline">
                {stats.map((stat) => (
                  <span key={stat.label} className="trace-zen-hud__stat">
                    <span className="trace-zen-hud__stat-value tabular-nums">
                      {stat.value}
                    </span>
                    <span className="trace-zen-hud__stat-label">{stat.label}</span>
                  </span>
                ))}
              </div>
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
                saveLabel={
                  isZenViewId(activeViewId) ? "Update Zen Space" : "Save Zen Space"
                }
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
