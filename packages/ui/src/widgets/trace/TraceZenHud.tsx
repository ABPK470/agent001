/**
 * Trace zen HUD — collapsed stats badge, exit pill, floating search overlay.
 */

import { Search, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { IdChip } from "./TraceCopy"

type MetaStat = { value: string; label?: string }

export function TraceZenHud({
  metaStats,
  runId,
  threadId,
  search,
  onSearchChange,
  searchOpen,
  onSearchOpenChange,
  onExitZen,
}: {
  metaStats: MetaStat[]
  runId: string | null
  threadId: string | null
  search: string
  onSearchChange: (value: string) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
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

  return (
    <div className="trace-zen-hud">
      <div className="trace-zen-hud__leading">
        {compactStats ? (
          <div
            className="trace-zen-hud__stats"
            onMouseEnter={() => setStatsOpen(true)}
            onMouseLeave={() => setStatsOpen(false)}
          >
            <button
              type="button"
              className="trace-zen-hud__stats-badge tabular-nums"
              aria-expanded={statsOpen}
            >
              {compactStats}
              <span className="trace-zen-hud__stats-info" aria-hidden>
                ℹ
              </span>
            </button>
            {statsOpen ? (
              <div className="trace-zen-hud__stats-popover" role="tooltip">
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
                {(runId || threadId) && (
                  <div className="trace-zen-hud__ids">
                    {runId ? <IdChip label="run" value={runId} tone="meta" /> : null}
                    {threadId ? <IdChip label="thread" value={threadId} tone="meta" /> : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

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

      {searchOpen ? (
        <div className="trace-zen-hud__search-overlay" role="dialog" aria-label="Filter trace">
          <div className="trace-zen-hud__search-panel">
            <Search size={14} className="trace-zen-hud__search-icon" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              className="trace-zen-hud__search-input"
              value={search}
              placeholder="Filter calls, tools, work…"
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
              className="trace-zen-hud__search-close"
              aria-label="Close filter"
              onClick={() => onSearchOpenChange(false)}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
