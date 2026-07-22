/**
 * Event Stream — Datadog-style live tail + time-bounded history.
 *
 * One stream (no separate "from database" pane):
 *   - One Filters sheet: quick range + From/Until + type + severity (Sync History dialect)
 *   - Scroll up → older pages within the range
 *   - SSE appends in Live; fixed ranges show "N new → Jump to live"
 *   - Search / type filters apply to the loaded buffer; deep search hits event_log
 */

import { ArrowDown, ChevronRight, Filter, Pause, Play, Radio, SlidersHorizontal } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../client/index"
import { DateField } from "../components/DateField"
import { EmptyState } from "../components/EmptyState"
import {
  ActiveFilterChips,
  FilterChoiceGrid,
  FilterField,
  FilterSheet,
  type ActiveFilterChipModel,
} from "../components/FilterSheet"
import { SqlTraceFromEventData } from "./sync/trace/SqlTrace"
import { JsonViewer } from "../components/JsonViewer"
import { useContainerSize } from "../hooks/useContainerSize"
import {
  type EventStreamRange,
  useEventStreamData,
} from "../hooks/useEventStreamData"
import { formatLogEntry } from "../state/store"
import type { LogEntry } from "../types"
import { isSyncSqlEventType } from "./sync/trace/sync-sql-trace"
import { WIDGET_ICONS } from "./widget-icons"
import {
  LOG_TOOLBAR_ICON_BTN,
  WidgetToolbarCount,
  WidgetToolbarSearch,
} from "./widget-toolbar"

const EVENT_TYPES = ["run", "step", "sync", "bridge", "agent", "api", "system"] as const
type EventType = (typeof EVENT_TYPES)[number]

const TYPE_OPTIONS = EVENT_TYPES.map((value) => ({ value, label: value }))

const QUICK_RANGES: { id: EventStreamRange; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "15m", label: "15m" },
  { id: "1h", label: "1h" },
  { id: "6h", label: "6h" },
  { id: "24h", label: "24h" },
]

function logSearchHaystack(log: LogEntry): string {
  return `${log.message} ${log.type} ${log.eventName ?? ""} ${JSON.stringify(log.data ?? {})}`.toLowerCase()
}

function logMatchesSearch(log: LogEntry, rawQuery: string): boolean {
  const words = rawQuery.trim().toLowerCase().split(/\s+/).filter((w) => w.length >= 2)
  if (words.length === 0) return true
  const hay = logSearchHaystack(log)
  return words.every((w) => hay.includes(w))
}

function logMatchesFilters(
  log: LogEntry,
  typeFilters: Set<EventType>,
  errorsOnly: boolean,
  searchText: string,
): boolean {
  const hasTypeFilter = typeFilters.size > 0 || errorsOnly
  if (hasTypeFilter) {
    const matchesType = typeFilters.size > 0 && typeFilters.has(log.type as EventType)
    const matchesError = errorsOnly && log.error
    if (!matchesType && !matchesError) return false
  }
  return logMatchesSearch(log, searchText)
}

function eventTypeDbPatterns(filters: Set<EventType>): string[] | undefined {
  if (filters.size === 0) return undefined
  const patterns: string[] = []
  for (const filter of filters) {
    if (filter === "sync") patterns.push("sync.")
    if (filter === "bridge") patterns.push("bridge.")
    if (filter === "run") patterns.push("run.")
    if (filter === "step") patterns.push("step.", "tool_call.")
    if (filter === "agent") patterns.push("delegation.", "planner.", "agent.", "debug.")
    if (filter === "api") patterns.push("api.")
    if (filter === "system") patterns.push("events.", "session.", "sync_env.")
  }
  return patterns.length > 0 ? patterns : undefined
}

const MSG_COLOR: Record<string, string> = {
  run: "var(--color-info)",
  step: "var(--color-accent)",
  sync: "var(--color-success)",
  bridge: "var(--color-accent)",
  agent: "var(--color-accent-hover)",
  api: "var(--color-accent)",
  system: "var(--color-text-muted)",
}

export function LiveLogs() {
  const [paused, setPaused] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [typeFilters, setTypeFilters] = useState<Set<EventType>>(new Set())
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [searchText, setSearchText] = useState("")
  const [filtersOpen, setFiltersOpen] = useState(false)

  const {
    entries,
    loading,
    loadingOlder,
    hasMore,
    loadOlder,
    error,
    pendingLiveCount,
    jumpToLive,
    window: timeWindow,
    setQuickRange,
    setFromDate,
    setToDate,
    clearCustomDates,
    followLive,
  } = useEventStreamData({ paused })

  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
  const filterBtnRef = useRef<HTMLButtonElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 860
  const tiny = rootWidth > 0 && rootWidth < 480

  // Deep search when the loaded window has no hits (same catalog formatting).
  const [searchHits, setSearchHits] = useState<LogEntry[]>([])
  const [searching, setSearching] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const filtered = useMemo(
    () => entries.filter((l) => logMatchesFilters(l, typeFilters, errorsOnly, searchText)),
    [entries, typeFilters, errorsOnly, searchText],
  )

  const searchActive = searchText.trim().length >= 2 || typeFilters.size > 0 || errorsOnly

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    setSearchHits([])
    if (!searchActive) return
    if (filtered.length > 0) return

    searchTimer.current = setTimeout(() => {
      const q = searchText.trim()
      const typePatterns = eventTypeDbPatterns(typeFilters)
      if (q.length < 2 && !typePatterns && !errorsOnly) return
      setSearching(true)
      void api
        .searchEvents(q.length >= 2 ? q : "", {
          type_patterns: errorsOnly ? ["%.failed", "%error%"] : typePatterns,
          limit: 300,
        })
        .then((res) => {
          const mapped: LogEntry[] = []
          for (const event of res.events) {
            const entry = formatLogEntry(event.type, event.data ?? {}, event.timestamp)
            if (entry) mapped.push(entry)
          }
          setSearchHits(mapped.reverse())
        })
        .catch(() => setSearchHits([]))
        .finally(() => setSearching(false))
    }, 500)

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [searchActive, searchText, typeFilters, errorsOnly, filtered.length])

  const searchOnly = useMemo(() => {
    if (filtered.length > 0 || searchHits.length === 0) return []
    const liveKeys = new Set(entries.map((l) => `${l.eventName}\0${l.timestamp}\0${l.message}`))
    return searchHits.filter(
      (l) =>
        !liveKeys.has(`${l.eventName}\0${l.timestamp}\0${l.message}`) &&
        logMatchesFilters(l, typeFilters, errorsOnly, searchText),
    )
  }, [filtered.length, searchHits, entries, typeFilters, errorsOnly, searchText])

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, error: 0 }
    for (const l of entries) {
      c.all++
      c[l.type] = (c[l.type] ?? 0) + 1
      if (l.error) c.error++
    }
    return c
  }, [entries])

  useEffect(() => {
    if (autoScroll && !paused && followLive) {
      const el = containerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [filtered, autoScroll, paused, followLive])

  function onScroll() {
    const el = containerRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
    if (el.scrollTop < 80) loadOlder()
  }

  const onQuickRange = useCallback(
    (next: EventStreamRange) => {
      setPaused(false)
      setAutoScroll(true)
      setQuickRange(next)
    },
    [setQuickRange],
  )

  const displayRows = filtered.length > 0 ? filtered : searchOnly
  const showEmpty =
    !loading &&
    !searching &&
    displayRows.length === 0 &&
    (searchActive || entries.length === 0)

  const hasCustomDates = Boolean(timeWindow.from || timeWindow.to)
  const timeFiltered = hasCustomDates || timeWindow.range !== "live"
  const filtersActive = typeFilters.size > 0 || errorsOnly || timeFiltered
  const activeFilterCount =
    typeFilters.size + (errorsOnly ? 1 : 0) + (hasCustomDates ? (timeWindow.from ? 1 : 0) + (timeWindow.to ? 1 : 0) : timeFiltered ? 1 : 0)

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
          id: "to",
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
        onRemove: () => onQuickRange("live"),
      })
    }
    for (const et of typeFilters) {
      chips.push({
        id: `type:${et}`,
        label: "Type",
        value: et,
        onRemove: () => {
          setTypeFilters((prev) => {
            const next = new Set(prev)
            next.delete(et)
            return next
          })
        },
      })
    }
    if (errorsOnly) {
      chips.push({
        id: "errors",
        label: "Errors",
        value: "only",
        onRemove: () => setErrorsOnly(false),
      })
    }
    return chips
  }, [
    hasCustomDates,
    timeWindow.from,
    timeWindow.to,
    timeWindow.range,
    typeFilters,
    errorsOnly,
    setFromDate,
    setToDate,
    onQuickRange,
  ])

  function clearAllFilters(): void {
    setTypeFilters(new Set())
    setErrorsOnly(false)
    clearCustomDates()
    onQuickRange("live")
  }

  return (
    <div ref={rootRef} className="h-full min-h-0 overflow-hidden flex flex-col text-text">
      {/* Sync History dialect: one Filters sheet (time + type), same choice grid. */}
      <div className="widget-toolbar shrink-0 m-3 mb-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="min-w-0 flex-1">
            <WidgetToolbarSearch
              value={searchText}
              onChange={setSearchText}
              placeholder="Search message, type, plan id…"
              loading={searching || loading}
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <WidgetToolbarCount filtered={filtered.length} total={entries.length} hidden={tiny} />

            <button
              ref={filterBtnRef}
              type="button"
              onClick={() => setFiltersOpen((o) => !o)}
              className={`widget-toolbar__icon-btn relative ${
                filtersOpen || filtersActive ? "text-accent" : ""
              }`}
              title={
                filtersActive
                  ? `Filters (${activeFilterCount} active)`
                  : "Filters"
              }
              aria-pressed={filtersOpen}
            >
              <SlidersHorizontal size={14} />
              {filtersActive && (
                <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-accent px-0.5 text-[9px] font-mono font-medium leading-none text-text-on-accent">
                  {activeFilterCount > 9 ? "9+" : activeFilterCount}
                </span>
              )}
            </button>

            <button
              type="button"
              title={paused ? `Resume (${pendingLiveCount} buffered)` : "Pause live append"}
              className={`${LOG_TOOLBAR_ICON_BTN} relative ${
                paused ? "bg-error/15 text-error" : "text-text-muted/60 hover:text-text hover:bg-elevated/40"
              }`}
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
              {paused && pendingLiveCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 text-xs font-bold bg-error text-text rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-0.5">
                  {pendingLiveCount > 99 ? "99+" : pendingLiveCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

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
        <FilterField label="Type">
          <FilterChoiceGrid
            options={TYPE_OPTIONS}
            values={[...typeFilters]}
            onChange={(values) => setTypeFilters(new Set(values))}
            columns={3}
            mode="multi"
          />
        </FilterField>
        <FilterField label="Severity">
          <FilterChoiceGrid
            options={[{ value: "errors" as const, label: "Errors only" }]}
            values={errorsOnly ? ["errors"] : []}
            onChange={(values) => setErrorsOnly(values.includes("errors"))}
            columns={3}
            mode="multi"
          />
        </FilterField>
      </FilterSheet>

      {(pendingLiveCount > 0 && (paused || !followLive)) && (
        <button
          type="button"
          className="flex items-center justify-center gap-1.5 py-1.5 text-sm text-accent hover:text-accent-hover bg-accent/5 border border-accent/20 rounded"
          onClick={() => {
            setPaused(false)
            setAutoScroll(true)
            jumpToLive()
          }}
        >
          <Radio size={14} />
          {pendingLiveCount} new event{pendingLiveCount === 1 ? "" : "s"} — Jump to live
        </button>
      )}

      {error && (
        <div className="px-3 py-2 text-sm text-error bg-error-soft rounded border border-error/20">
          {error}
        </div>
      )}

      <div
        ref={containerRef}
        className="log-stream flex min-h-0 flex-1 flex-col overflow-y-auto"
        onScroll={onScroll}
      >
        <div ref={topSentinelRef} />

        {loadingOlder && (
          <div className="px-3 py-2 text-sm text-text-muted text-center">Loading older events…</div>
        )}
        {!loadingOlder && hasMore && (
          <button
            type="button"
            className="px-3 py-2 text-sm text-accent hover:text-accent-hover"
            onClick={() => loadOlder()}
          >
            Load older events
          </button>
        )}

        {loading && entries.length === 0 && (
          <EmptyState icon={WIDGET_ICONS["live-logs"]} message="Loading event history…" />
        )}

        {!loading && entries.length === 0 && !searchActive && (
          <EmptyState icon={WIDGET_ICONS["live-logs"]} message="No events in this time range." />
        )}

        {displayRows.map((log, i) => (
          <LogRow
            key={`${log.timestamp}|${log.eventName ?? ""}|${i}`}
            log={log}
            setTypeFilters={setTypeFilters}
            compact={compact}
            tiny={tiny}
          />
        ))}

        {filtered.length === 0 && searchOnly.length > 0 && (
          <div className="px-3 py-2 text-sm text-text-muted bg-elevated/30 border-t border-border-subtle">
            Search matches outside the loaded window ({searchOnly.length})
          </div>
        )}

        {showEmpty && searchActive && (
          <EmptyState
            icon={Filter}
            message="No matches in this range."
            detail="Widen the time range, clear filters, or try different keywords."
          />
        )}

        <div ref={bottomRef} />
      </div>

      {!autoScroll && !paused && followLive && (
        <button
          type="button"
          className="flex items-center justify-center gap-1.5 py-1.5 text-sm text-accent hover:text-accent-hover transition-colors"
          onClick={() => {
            setAutoScroll(true)
            bottomRef.current?.scrollIntoView({ behavior: "smooth" })
          }}
        >
          <ArrowDown size={14} /> Jump to latest
        </button>
      )}
    </div>
  )
}

function formatLogTimestamp(iso: string | undefined, tiny: boolean): string {
  if (!iso) return ""
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    const date = iso.slice(0, 10)
    const time = iso.slice(11, 19)
    return date && time ? `${date} ${time}` : iso
  }
  const date = d.toLocaleDateString(undefined, tiny
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" })
  const time = d.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  return `${date} ${time}`
}

function LogRow({
  log,
  setTypeFilters,
  compact,
  tiny,
}: {
  log: LogEntry
  setTypeFilters: React.Dispatch<React.SetStateAction<Set<EventType>>>
  compact: boolean
  tiny: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const msgColor = log.error ? "var(--color-error)" : (MSG_COLOR[log.type] ?? "var(--color-text-muted)")
  const hasData = log.data && Object.keys(log.data).length > 0

  return (
    <div>
      <div
        className={`flex items-baseline gap-2.5 py-1 px-3 ${
          log.error ? "bg-error-soft" : "hover:bg-overlay-1"
        } ${hasData ? "cursor-pointer" : ""}`}
        onClick={() => hasData && setExpanded((e) => !e)}
      >
        <span className="shrink-0 w-3 flex items-center justify-center" style={{ color: msgColor, opacity: 0.3 }}>
          {hasData ? <ChevronRight size={13} className={`transition-transform ${expanded ? "rotate-90" : ""}`} /> : null}
        </span>
        <span className="shrink-0 text-sm tabular-nums whitespace-nowrap" style={{ color: msgColor, opacity: 0.55 }}>
          {formatLogTimestamp(log.timestamp, tiny)}
        </span>
        <button
          type="button"
          className="shrink-0 w-14 text-sm font-medium text-left truncate hover:opacity-70 transition-opacity text-text-muted"
          onClick={(e) => {
            e.stopPropagation()
            setTypeFilters((prev) => {
              const next = new Set(prev)
              const t = log.type as EventType
              if (next.has(t)) next.delete(t)
              else next.add(t)
              return next
            })
          }}
        >
          {log.type}
        </button>
        <span
          className={`shrink-0 text-sm text-text-muted/50 truncate ${compact ? "max-w-[9rem]" : "max-w-[14rem]"}`}
          title={log.eventName ?? ""}
        >
          {log.eventName ?? ""}
        </span>
        <span className="min-w-0 break-all text-sm" style={{ color: msgColor }}>
          {log.message}
        </span>
      </div>
      {expanded && log.data && (
        <div className={`${compact ? "pl-3 pr-3" : "pl-[7rem] pr-4"} py-2 bg-base border-l-2 border-border-subtle ml-3 space-y-2`}>
          {log.eventName && isSyncSqlEventType(log.eventName) && (
            <SqlTraceFromEventData data={log.data} compact maxHeight={compact ? 120 : 180} />
          )}
          <JsonViewer value={log.data} label="payload" defaultExpandDepth={2} maxHeight={compact ? 160 : 240} />
        </div>
      )}
    </div>
  )
}
