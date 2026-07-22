/**
 * Event Stream — Datadog-style live tail + time-bounded history.
 *
 * One stream (no separate "from database" pane):
 *   - Range chips: Live (last 1h + follow) | 15m | 1h | 6h | 24h
 *   - Scroll up → older pages within the range
 *   - SSE appends in Live; fixed ranges show "N new → Jump to live"
 *   - Search / type filters apply to the loaded buffer; deep search hits event_log
 */

import { AlertCircle, ArrowDown, ChevronRight, Filter, Pause, Play, Radio } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../client/index"
import { EmptyState } from "../components/EmptyState"
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
  LOG_TOOLBAR_CHIP,
  LOG_TOOLBAR_CHIP_ACTIVE,
  LOG_TOOLBAR_CHIP_IDLE,
  LOG_TOOLBAR_DIVIDER,
  LOG_TOOLBAR_ICON_BTN,
  LogWidgetToolbar,
  LogWidgetToolbarCount,
  LogWidgetToolbarFilters,
  LogWidgetToolbarSearch,
  LogWidgetToolbarTail,
  WidgetToolbarFilterMenu,
  WidgetToolbarFilterMenuItem,
} from "./widget-toolbar"

const EVENT_TYPES = ["all", "run", "step", "sync", "bridge", "agent", "api", "system"] as const
type EventType = (typeof EVENT_TYPES)[number]

const RANGES: { id: EventStreamRange; label: string }[] = [
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

  const {
    entries,
    loading,
    loadingOlder,
    hasMore,
    loadOlder,
    error,
    pendingLiveCount,
    jumpToLive,
    range,
    setRange,
  } = useEventStreamData({ paused })

  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const topSentinelRef = useRef<HTMLDivElement>(null)
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
    if (autoScroll && !paused && range === "live") {
      const el = containerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [filtered, autoScroll, paused, range])

  function onScroll() {
    const el = containerRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
    if (el.scrollTop < 80) loadOlder()
  }

  const onRangeClick = useCallback(
    (next: EventStreamRange) => {
      setPaused(false)
      setAutoScroll(true)
      setRange(next)
    },
    [setRange],
  )

  const displayRows = filtered.length > 0 ? filtered : searchOnly
  const showEmpty =
    !loading &&
    !searching &&
    displayRows.length === 0 &&
    (searchActive || entries.length === 0)

  return (
    <div ref={rootRef} className="h-full min-h-0 overflow-hidden flex flex-col gap-2.5 text-text">
      <LogWidgetToolbar compact={compact}>
        <LogWidgetToolbarFilters>
          {RANGES.map((r) => {
            const active = range === r.id
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => onRangeClick(r.id)}
                className={`${LOG_TOOLBAR_CHIP} ${active ? LOG_TOOLBAR_CHIP_ACTIVE : LOG_TOOLBAR_CHIP_IDLE}`}
                title={
                  r.id === "live"
                    ? "Last 1 hour + follow new events"
                    : `Events from the last ${r.label}`
                }
              >
                {r.id === "live" && <Radio size={12} className={active ? "text-accent" : ""} />}
                {r.label}
              </button>
            )
          })}

          {!compact && <div className={LOG_TOOLBAR_DIVIDER} aria-hidden />}

          {!compact ? (
            EVENT_TYPES.map((et) => {
              const active = et === "all" ? typeFilters.size === 0 : typeFilters.has(et)
              const count = counts[et] ?? 0
              return (
                <button
                  key={et}
                  type="button"
                  onClick={() => {
                    if (et === "all") setTypeFilters(new Set())
                    else {
                      setTypeFilters((prev) => {
                        const next = new Set(prev)
                        if (next.has(et)) next.delete(et)
                        else next.add(et)
                        return next
                      })
                    }
                  }}
                  className={`${LOG_TOOLBAR_CHIP} ${active ? LOG_TOOLBAR_CHIP_ACTIVE : LOG_TOOLBAR_CHIP_IDLE}`}
                >
                  {et}
                  {count > 0 && (
                    <span className={`text-xs tabular-nums ${active ? "text-accent/60" : "text-text-muted/40"}`}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })
          ) : (
            <WidgetToolbarFilterMenu
              ariaLabel="Filter event types"
              active={typeFilters.size > 0}
              label={
                <>
                  <Filter size={14} />
                  {typeFilters.size === 0 ? "all" : `${typeFilters.size} types`}
                </>
              }
            >
              {EVENT_TYPES.map((et) => {
                const active = et === "all" ? typeFilters.size === 0 : typeFilters.has(et)
                const count = counts[et] ?? 0
                return (
                  <WidgetToolbarFilterMenuItem
                    key={et}
                    label={et}
                    active={active}
                    count={count}
                    onClick={() => {
                      if (et === "all") {
                        setTypeFilters(new Set())
                        return
                      }
                      setTypeFilters((prev) => {
                        const next = new Set(prev)
                        if (next.has(et)) next.delete(et)
                        else next.add(et)
                        return next
                      })
                    }}
                  />
                )
              })}
            </WidgetToolbarFilterMenu>
          )}

          <button
            type="button"
            onClick={() => setErrorsOnly((e) => !e)}
            className={`${LOG_TOOLBAR_CHIP} shrink-0 ${
              errorsOnly ? "bg-error-soft text-error font-medium" : LOG_TOOLBAR_CHIP_IDLE
            }`}
            title="Errors only"
          >
            <AlertCircle size={14} />
            {!tiny && "errors"}
            {(counts.error ?? 0) > 0 && (
              <span className={`text-xs tabular-nums ${errorsOnly ? "text-error/60" : "text-text-muted/40"}`}>
                {counts.error}
              </span>
            )}
          </button>
        </LogWidgetToolbarFilters>

        <LogWidgetToolbarSearch
          value={searchText}
          onChange={setSearchText}
          placeholder="Search message, event type, plan id…"
          loading={searching || loading}
        />

        <LogWidgetToolbarTail>
          <LogWidgetToolbarCount filtered={filtered.length} total={entries.length} hidden={tiny} />

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
        </LogWidgetToolbarTail>
      </LogWidgetToolbar>

      {(pendingLiveCount > 0 && (paused || range !== "live")) && (
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

      {!autoScroll && !paused && range === "live" && (
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
