/**
 * Trace zen HUD — row-1 controls: stats, search, exit + run context.
 */

import { ChevronDown, Info, Search, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { TraceRunContext } from "./TraceRunContext"
import { TraceTreeFoldToggle } from "./TraceTreeFoldToggle"
import type { FoldMode } from "./open-state"

type MetaStat = { value: string; label?: string }

export function TraceZenHud({
  metaStats,
  search,
  onSearchChange,
  searchOpen,
  onSearchOpenChange,
  foldMode,
  onFoldModeChange,
  viewMode,
  onExitZen,
}: {
  metaStats: MetaStat[]
  search: string
  onSearchChange: (value: string) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  foldMode: FoldMode
  onFoldModeChange: (mode: FoldMode) => void
  viewMode: "tree" | "waterfall"
  onExitZen: () => void
}) {
  const [statsOpen, setStatsOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const compactStats = metaStats
    .filter((stat) => stat.label !== "in" && stat.label !== "out")
    .slice(0, 3)
    .map((stat) => (stat.label ? `${stat.value} ${stat.label}` : stat.value))
    .join(" · ")

  useEffect(() => {
    if (!searchOpen) return
    const t = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [searchOpen])

  function onToggleStats() {
    setStatsOpen((open) => !open)
  }

  function onDismissSearch() {
    if (search) onSearchChange("")
    else onSearchOpenChange(false)
  }

  return (
    <div className="trace-zen-hud trace-split-header-row trace-split-header-row--primary">
      {searchOpen ? (
        <div className="trace-zen-hud__search-inline" role="search">
          <Search size={14} className="trace-zen-hud__search-icon" aria-hidden />
          <input
            ref={searchRef}
            type="text"
            className="trace-zen-hud__search-input"
            value={search}
            placeholder="Filter calls, tools, work…"
            aria-label="Filter trace"
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                onSearchOpenChange(false)
              }
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
        </div>
      ) : (
        <>
          <div className="trace-zen-hud__leading">
            {compactStats ? (
              <div className="trace-zen-hud__stats">
                <button
                  type="button"
                  className="trace-zen-hud__stats-badge tabular-nums"
                  aria-expanded={statsOpen}
                  aria-haspopup="dialog"
                  onClick={onToggleStats}
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
                {statsOpen ? (
                  <div className="trace-zen-hud__stats-popover" role="dialog" aria-label="Run stats">
                    <div className="trace-zen-hud__stats-grid">
                      {metaStats.map((stat) => (
                        <span key={`${stat.value}:${stat.label ?? ""}`} className="trace-zen-hud__stat">
                          <span className="trace-zen-hud__stat-value tabular-nums">{stat.value}</span>
                          {stat.label ? (
                            <span className="trace-zen-hud__stat-label">{stat.label}</span>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            <TraceRunContext className="trace-run-context--zen" />
            {viewMode === "tree" ? (
              <TraceTreeFoldToggle
                foldMode={foldMode}
                onFoldModeChange={onFoldModeChange}
              />
            ) : null}
          </div>

          <div className="trace-zen-hud__trailing">
            <button
              type="button"
              className="trace-zen-hud__icon-btn"
              title="Filter (⌘F or /)"
              aria-label="Filter trace"
              onClick={() => onSearchOpenChange(true)}
            >
              <Search size={14} />
            </button>

            <span className="trace-zen-hud__hint" aria-hidden>
              <kbd>Esc</kbd>
            </span>

            <button
              type="button"
              className="trace-zen-hud__icon-btn"
              title="Exit focus (Esc or Z)"
              aria-label="Exit focus mode"
              onClick={onExitZen}
            >
              <X size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}
