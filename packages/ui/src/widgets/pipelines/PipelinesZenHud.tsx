/**
 * Pipelines zen HUD — full-width strip: title + fold left, actions right.
 * Same bar dialect as Active Users (not a left-clustered icon pile).
 */

import { Search, SlidersHorizontal, X } from "lucide-react"
import { useEffect, useRef, type RefObject } from "react"
import { ReviewTreeFoldToggle } from "../../components/review"
import type { ReviewTreeFoldMode } from "../../components/review/review-tree-open-state"
import { ZenSessionHudActions } from "../../components/ZenSessionHudActions"
import { formatModChord } from "../../lib/keymap"
import { isZenViewId } from "../../lib/zen-session"
import { useLayoutStore } from "../../state/layout-store"

export function PipelinesZenHud({
  search,
  onSearchChange,
  searchOpen,
  onSearchOpenChange,
  searchPending,
  filtersActive,
  activeFilterCount,
  onOpenFilters,
  filterBtnRef,
  treeFoldMode,
  onTreeFoldModeChange,
  onExitZen,
}: {
  search: string
  onSearchChange: (value: string) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  searchPending: boolean
  filtersActive: boolean
  activeFilterCount: number
  onOpenFilters: () => void
  filterBtnRef: RefObject<HTMLButtonElement | null>
  treeFoldMode: ReviewTreeFoldMode
  onTreeFoldModeChange: (mode: ReviewTreeFoldMode) => void
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
    if (search) onSearchChange("")
    else onSearchOpenChange(false)
  }

  return (
    <div className="trace-zen-hud pipelines-zen-hud">
      <div className="trace-zen-hud__bar">
        {searchOpen ? (
          <div className="trace-zen-hud__search-inline" role="search">
            <Search size={14} className="trace-zen-hud__search-icon" aria-hidden />
            <input
              ref={searchRef}
              type="text"
              className="trace-zen-hud__search-input"
              value={search}
              placeholder="Filter pipelines…"
              aria-label="Filter pipelines"
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return
                event.preventDefault()
                event.stopPropagation()
                onDismissSearch()
              }}
            />
            <button
              type="button"
              className="trace-zen-hud__search-clear"
              aria-label={search ? "Clear filter" : "Close filter"}
              title={search ? "Clear" : "Close filter (Esc)"}
              onClick={onDismissSearch}
            >
              <X size={14} />
            </button>
            {searchPending ? (
              <span className="trace-zen-hud__hint text-text-faint" aria-hidden>
                …
              </span>
            ) : null}
          </div>
        ) : (
          <>
            <div className="trace-zen-hud__leading">
              <span className="trace-zen-hud__title">Pipelines</span>
              <ReviewTreeFoldToggle
                foldMode={treeFoldMode}
                onFoldModeChange={onTreeFoldModeChange}
              />
            </div>
            <div className="trace-zen-hud__trailing">
              <button
                type="button"
                className="trace-zen-hud__icon-btn"
                title={`Filter (${formatModChord("F")} or /)`}
                aria-label="Filter pipelines"
                onClick={() => onSearchOpenChange(true)}
              >
                <Search size={14} />
              </button>
              <button
                ref={filterBtnRef}
                type="button"
                className={`trace-zen-hud__icon-btn${filtersActive ? " is-active" : ""}`}
                title={
                  filtersActive
                    ? `Filters (${activeFilterCount} active)`
                    : "Filters"
                }
                aria-pressed={filtersActive}
                onClick={onOpenFilters}
              >
                <SlidersHorizontal size={14} strokeWidth={1.75} />
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
