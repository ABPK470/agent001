/**
 * Event Stream — live platform event log.
 *
 * Design:
 *   - Muted monochrome toolbar, no colored dots — clean enterprise look
 *   - Message text color varies by type — like proper server terminal output
 *   - Filter input prominent with visible border
 *   - Generous padding / spacing throughout
 *   - Click any row to expand raw event payload
 */

import { AlertCircle, ArrowDown, ChevronRight, Database, Filter, Pause, Play } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useContainerSize } from "../hooks/useContainerSize"
import { formatLogEntry, useStore } from "../store"
import type { LogEntry } from "../types"
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

// ── Type chips shown in toolbar (order matters) ──────────────────

const EVENT_TYPES = ["all", "run", "step", "sync", "agent", "api", "system"] as const
type EventType = (typeof EVENT_TYPES)[number]

/** Map UI filter chips → event_log.type LIKE prefixes for DB search. */
function eventTypeDbPatterns(filters: Set<EventType>): string[] | undefined {
  if (filters.size === 0) return undefined
  const patterns: string[] = []
  for (const filter of filters) {
    if (filter === "sync") patterns.push("sync.")
    if (filter === "run") patterns.push("run.")
    if (filter === "step") patterns.push("step.", "tool_call.")
    if (filter === "agent") patterns.push("delegation.", "planner.", "agent.", "debug.")
    if (filter === "api") patterns.push("api.")
    if (filter === "system") patterns.push("events.", "session.", "sync_env.")
  }
  return patterns.length > 0 ? patterns : undefined
}

/** Message text color per type — the core visual differentiation. */
const MSG_COLOR: Record<string, string> = {
  run:    "var(--color-info)",
  step:   "var(--color-accent)",
  sync:   "var(--color-success)",
  agent:  "var(--color-accent-hover)",
  api:    "var(--color-accent)",
  system: "var(--color-text-muted)",
}

// ── Component ────────────────────────────────────────────────────

export function LiveLogs() {
  const logs = useStore((s) => s.logs)
  const [paused, setPaused] = useState(false)
  const [snapshot, setSnapshot] = useState<LogEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [typeFilters, setTypeFilters] = useState<Set<EventType>>(new Set())
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [searchText, setSearchText] = useState("")
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 860
  const tiny = rootWidth > 0 && rootWidth < 480

  // DB fallback search — triggered when in-memory results = 0 and query ≥ 3 chars
  const [dbResults, setDbResults] = useState<LogEntry[]>([])
  const [dbSearching, setDbSearching] = useState(false)
  const [dbQuery, setDbQuery] = useState("")
  const dbTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runDbSearch = useCallback(async (q: string, filters: Set<EventType>, errorsOnlySearch: boolean) => {
    const typePatterns = eventTypeDbPatterns(filters)
    const canSearchText = q.trim().length >= 2
    if (!canSearchText && !typePatterns && !errorsOnlySearch) {
      setDbResults([])
      setDbQuery("")
      return
    }
    setDbSearching(true)
    try {
      const res = await api.searchEvents(canSearchText ? q.trim() : "", {
        type_patterns: errorsOnlySearch
          ? ["%.failed", "%error%"]
          : typePatterns,
        limit: 200,
      })
      const entries: LogEntry[] = []
      for (const event of res.events) {
        const entry = formatLogEntry(event.type, event.data ?? {}, event.timestamp)
        if (entry) entries.push(entry)
      }
      setDbResults(entries)
      setDbQuery(q.trim())
    } catch { /* ignore */ }
    setDbSearching(false)
  }, [])

  // Fall back to SQLite when in-memory buffer has no matches (or user is
  // filtering by type/errors). UI chips use groups like "sync"; DB rows use
  // types like "sync.preview.started" — search via type_patterns, not exact type.
  useEffect(() => {
    setDbResults([])
    setDbQuery("")
    if (dbTimer.current) clearTimeout(dbTimer.current)
    const canSearchText = searchText.trim().length >= 2
    const hasTypeFilter = typeFilters.size > 0 || errorsOnly
    if (!canSearchText && !hasTypeFilter) return
    dbTimer.current = setTimeout(() => {
      void runDbSearch(searchText, typeFilters, errorsOnly)
    }, 600)
    return () => { if (dbTimer.current) clearTimeout(dbTimer.current) }
  }, [searchText, typeFilters, errorsOnly, runDbSearch])

  // Freeze on pause
  useEffect(() => {
    if (paused) setSnapshot([...logs])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused])

  const source = paused ? snapshot : logs

  // Counts per type + error count
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, error: 0 }
    for (const l of source) {
      c.all++
      c[l.type] = (c[l.type] ?? 0) + 1
      if (l.error) c.error++
    }
    return c
  }, [source])

  // Filter pipeline — type chips + errors are OR-combined, search is AND
  const filtered = useMemo(() => {
    const needle = searchText.trim().toLowerCase()
    return source.filter((l) => {
      const hasTypeFilter = typeFilters.size > 0 || errorsOnly
      if (hasTypeFilter) {
        const matchesType = typeFilters.size > 0 && typeFilters.has(l.type as EventType)
        const matchesError = errorsOnly && l.error
        if (!matchesType && !matchesError) return false
      }
      if (needle && !`${l.message} ${l.type}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [source, typeFilters, errorsOnly, searchText])

  // Auto-scroll — use scrollTop for reliable rapid-fire updates
  useEffect(() => {
    if (autoScroll && !paused) {
      const el = containerRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
  }, [filtered, autoScroll, paused])

  function handleScroll() {
    const el = containerRef.current
    if (!el) return
    setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const pendingCount = paused ? Math.max(0, logs.length - snapshot.length) : 0

  return (
    <div ref={rootRef} className="h-full min-h-0 overflow-hidden flex flex-col gap-2.5 text-text">

      <LogWidgetToolbar compact={compact}>
        <LogWidgetToolbarFilters>
          {!compact ? (
            EVENT_TYPES.map((et) => {
              const active = et === "all" ? typeFilters.size === 0 : typeFilters.has(et)
              const count = counts[et] ?? 0
              return (
                <button
                  key={et}
                  onClick={() => {
                    if (et === "all") {
                      setTypeFilters(new Set())
                    } else {
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
              label={(
                <>
                  <Filter size={14} />
                  {typeFilters.size === 0 ? "all" : `${typeFilters.size} types`}
                </>
              )}
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

          {!compact && <div className={LOG_TOOLBAR_DIVIDER} aria-hidden />}

          <button
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
          placeholder="Filter events…"
        />

        <LogWidgetToolbarTail>
          <LogWidgetToolbarCount filtered={filtered.length} total={source.length} hidden={tiny} />

          <button
            title={paused ? `Resume (${pendingCount} buffered)` : "Pause"}
            className={`${LOG_TOOLBAR_ICON_BTN} relative ${
              paused ? "bg-error/15 text-error" : "text-text-muted/60 hover:text-text hover:bg-elevated/40"
            }`}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
            {paused && pendingCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 text-xs font-bold bg-error text-text rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-0.5">
                {pendingCount > 99 ? "99+" : pendingCount}
              </span>
            )}
          </button>
        </LogWidgetToolbarTail>
      </LogWidgetToolbar>

      {/* ── Log body ─────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="log-stream flex-1 min-h-0 overflow-y-auto"
        onScroll={handleScroll}
      >
        {filtered.length === 0 && (
          <div className="text-text-muted text-center pt-12 font-sans text-sm">
            {source.length === 0 ? "Waiting for events…" : "No matches"}
          </div>
        )}

        {filtered.map((log, i) => (
          <LogRow key={i} log={log} setTypeFilters={setTypeFilters} compact={compact} tiny={tiny} />
        ))}

        {(searchText.trim().length >= 2 || typeFilters.size > 0 || errorsOnly) && filtered.length === 0 && (
          <div>
            {dbSearching && (
              <div className="text-text-muted text-sm text-center py-4">Searching event log database…</div>
            )}
            {!dbSearching && dbQuery === searchText.trim() && dbResults.length === 0 && (
              <div className="text-text-muted text-sm text-center py-4">No matches in database either.</div>
            )}
            {!dbSearching && dbResults.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted border-y border-border-subtle">
                  <Database size={14} />
                  <span>
                    Database — {dbResults.length} historical match{dbResults.length === 1 ? "" : "es"}
                    {dbQuery ? ` for "${dbQuery}"` : ""}
                  </span>
                </div>
                {dbResults.map((log, i) => (
                  <LogRow key={`db:${i}`} log={log} setTypeFilters={setTypeFilters} compact={compact} tiny={tiny} />
                ))}
              </>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {!autoScroll && !paused && (
        <button
          className="flex items-center justify-center gap-1.5 py-1.5 text-sm text-accent hover:text-accent-hover transition-colors"
          onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: "smooth" }) }}
        >
          <ArrowDown size={14} /> New events
        </button>
      )}
    </div>
  )
}

// ── Expandable log row ───────────────────────────────────────────

function LogRow({ log, setTypeFilters, compact, tiny }: {
  log: LogEntry; setTypeFilters: React.Dispatch<React.SetStateAction<Set<EventType>>>; compact: boolean; tiny: boolean
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
        <span className="shrink-0 text-sm tabular-nums" style={{ color: msgColor, opacity: 0.55 }}>
          {tiny ? log.timestamp?.slice(11, 19) : log.timestamp?.slice(11, 23)}
        </span>
        <button
          className="shrink-0 w-16 text-sm font-medium text-left truncate hover:opacity-70 transition-opacity text-text-muted"
          onClick={(e) => { e.stopPropagation(); setTypeFilters((prev) => { const next = new Set(prev); const t = log.type as EventType; if (next.has(t)) next.delete(t); else next.add(t); return next }) }}
        >
          {log.type}
        </button>
        {!compact && (
          <span className="shrink-0 text-sm text-text-muted/50 whitespace-nowrap">
            {log.eventName ?? ""}
          </span>
        )}
        <span className="min-w-0 break-all text-sm" style={{ color: msgColor }}>
          {log.message}
        </span>
      </div>
      {expanded && log.data && (
        <div className={`${compact ? "pl-3 pr-3" : "pl-[7rem] pr-4"} py-2 bg-base border-l-2 border-border-subtle ml-3`}>
          <pre className="log-payload m-0">
            {JSON.stringify(log.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
