/**
 * Trace zen HUD — Thread › Run scope owns the strip; search / fold / exit trail.
 * No run-stats badge — telemetry stays on the chrome toolbar outside zen.
 */

import { PanelLeft, Search, X } from "lucide-react"
import { useEffect, useRef } from "react"
import { ZenSessionHudActions } from "../../components/ZenSessionHudActions"
import { formatModChord } from "../../lib/keymap"
import { useLayoutStore } from "../../state/layout-store"
import { TraceRunContext } from "./TraceRunContext"
import { TraceTreeFoldToggle } from "./TraceTreeFoldToggle"
import type { FoldMode } from "./open-state"

export function TraceZenHud({
  search,
  onSearchChange,
  searchOpen,
  onSearchOpenChange,
  foldMode,
  onFoldModeChange,
  viewMode,
  scopeDrawerOpen,
  onScopeDrawerOpenChange,
  onExitZen,
}: {
  search: string
  onSearchChange: (value: string) => void
  searchOpen: boolean
  onSearchOpenChange: (open: boolean) => void
  foldMode: FoldMode
  onFoldModeChange: (mode: FoldMode) => void
  viewMode: "tree" | "waterfall"
  scopeDrawerOpen: boolean
  onScopeDrawerOpenChange: (open: boolean) => void
  onExitZen: () => void
}) {
  const saveZenSpace = useLayoutStore((s) => s.saveZenSpace)
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
              if (event.key !== "Escape") return
              event.preventDefault()
              event.stopPropagation()
              // Clear first; empty Esc closes the overlay (same peel as Active Users).
              if (search) onSearchChange("")
              else onSearchOpenChange(false)
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
            <button
              type="button"
              className={`trace-scope-drawer-toggle${scopeDrawerOpen ? " is-open" : ""}`}
              aria-label={scopeDrawerOpen ? "Close thread drawer" : "Open thread drawer"}
              aria-expanded={scopeDrawerOpen}
              title={`Thread / run drawer (${formatModChord("\\")})`}
              onClick={() => onScopeDrawerOpenChange(!scopeDrawerOpen)}
            >
              <PanelLeft size={14} strokeWidth={2} aria-hidden />
            </button>
            <TraceRunContext expanded className="trace-run-context--zen" />
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
              title={`Filter (${formatModChord("F")} or /)`}
              aria-label="Filter trace"
              onClick={() => onSearchOpenChange(true)}
            >
              <Search size={14} />
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
  )
}
