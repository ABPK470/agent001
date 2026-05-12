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

import { AlertCircle, ArrowDown, ChevronRight, Database, Filter, Pause, Play, Search, X } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useContainerSize } from "../hooks/useContainerSize"
import { useStore } from "../store"
import type { LogEntry } from "../types"

// ── Type chips shown in toolbar (order matters) ──────────────────

const EVENT_TYPES = ["all", "run", "step", "sync", "agent", "api", "system"] as const
type EventType = (typeof EVENT_TYPES)[number]

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
  const [chipsOpen, setChipsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  // DB fallback search — triggered when in-memory results = 0 and query ≥ 3 chars
  const [dbResults, setDbResults] = useState<LogEntry[]>([])
  const [dbSearching, setDbSearching] = useState(false)
  const [dbQuery, setDbQuery] = useState("")
  const dbTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runDbSearch = useCallback(async (q: string, types: string[]) => {
    if (q.length < 3) { setDbResults([]); setDbQuery(""); return }
    setDbSearching(true)
    try {
      const res = await api.searchEvents(q, { types: types.length ? types : undefined, limit: 200 })
      setDbResults(res.events.map((e) => ({
        type: e.type,
        message: (e.data["message"] as string | undefined) ?? JSON.stringify(e.data).slice(0, 120),
        timestamp: e.timestamp,
        eventName: (e.data["event"] as string | undefined) ?? undefined,
        data: e.data,
        error: !!(e.data["error"]),
      })))
      setDbQuery(q)
    } catch { /* ignore */ }
    setDbSearching(false)
  }, [])

  // When search text changes: reset DB results immediately; if in-memory has 0
  // matches after 600ms debounce, fall back to DB search.
  useEffect(() => {
    setDbResults([])
    setDbQuery("")
    if (dbTimer.current) clearTimeout(dbTimer.current)
    if (!searchText || searchText.length < 3) return
    dbTimer.current = setTimeout(() => {
      void runDbSearch(searchText, [...typeFilters])
    }, 600)
    return () => { if (dbTimer.current) clearTimeout(dbTimer.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, typeFilters])

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
      // Type + error filtering: if any chips are active, the log must match
      // at least one selected type OR be an error (when errors is toggled on)
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
    <div ref={rootRef} className="h-full overflow-hidden flex flex-col gap-2.5 text-text">

      {/* ── Toolbar ──────────────────────────────────────── */}
      <div className="rounded-lg border border-border-subtle bg-overlay-1 shrink-0">
        <div className={`flex items-center gap-1.5 px-3 py-2 ${compact ? "flex-wrap" : ""}`}>

          {/* Type chips — full row on wide, dropdown on compact */}
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
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors whitespace-nowrap ${
                    active
                      ? "bg-accent/15 text-accent font-medium"
                      : "text-text-muted hover:text-text-secondary hover:bg-elevated/40"
                  }`}
                >
                  {et}
                  {count > 0 && (
                    <span className={`text-[11px] tabular-nums ${active ? "text-accent/60" : "text-text-muted/40"}`}>
                      {count}
                    </span>
                  )}
                </button>
              )
            })
          ) : (
            <div className="relative shrink-0">
              <button
                onClick={() => setChipsOpen((v) => !v)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors whitespace-nowrap ${
                  typeFilters.size > 0
                    ? "bg-accent/15 text-accent font-medium"
                    : "text-text-muted hover:text-text-secondary hover:bg-elevated/40"
                }`}
              >
                <Filter size={13} />
                {typeFilters.size === 0 ? "all" : `${typeFilters.size} types`}
              </button>
              {chipsOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setChipsOpen(false)} />
                  <div className="absolute left-0 top-full mt-1 z-50 bg-elevated border border-border rounded-md shadow-2xl py-1 min-w-[160px]">
                    {EVENT_TYPES.map((et) => {
                      const active = et === "all" ? typeFilters.size === 0 : typeFilters.has(et)
                      const count = counts[et] ?? 0
                      return (
                        <button
                          key={et}
                          onClick={() => {
                            if (et === "all") setTypeFilters(new Set())
                            else setTypeFilters((prev) => {
                              const next = new Set(prev)
                              if (next.has(et)) next.delete(et)
                              else next.add(et)
                              return next
                            })
                          }}
                          className={`flex items-center justify-between gap-3 w-full text-left px-3 py-2 text-[13px] transition-colors ${
                            active ? "text-accent bg-accent/10" : "text-text-muted hover:text-text hover:bg-overlay-2"
                          }`}
                        >
                          <span>{et}</span>
                          {count > 0 && <span className="text-[11px] tabular-nums text-text-muted/60">{count}</span>}
                        </button>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {!compact && <div className="h-4 w-px bg-overlay-3 mx-1 shrink-0" />}

          {/* Errors toggle */}
          <button
            onClick={() => setErrorsOnly((e) => !e)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors whitespace-nowrap shrink-0 ${
              errorsOnly
                ? "bg-error-soft text-error font-medium"
                : "text-text-muted hover:text-text-secondary hover:bg-elevated/40"
            }`}
            title="Errors only"
          >
            <AlertCircle size={13} />
            {!tiny && "errors"}
            {(counts.error ?? 0) > 0 && (
              <span className={`text-[11px] tabular-nums ${errorsOnly ? "text-error/60" : "text-text-muted/40"}`}>
                {counts.error}
              </span>
            )}
          </button>

          <div className="flex-1 min-w-0" />

          {/* Search — full input on wide, icon-toggle on compact */}
          {!compact ? (
            <div className="relative flex items-center flex-1 min-w-0 max-w-lg shrink-0">
              <Search size={13} className="absolute left-2.5 text-text-muted/50 pointer-events-none" />
              <input
                type="text"
                placeholder="Filter events…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="pl-8 pr-7 py-1.5 h-[32px] w-full text-[13px] bg-base border border-border rounded-md text-text placeholder:text-text-muted/50 outline-none focus:border-accent transition-colors"
              />
              {searchText && (
                <button className="absolute right-2 text-text-muted hover:text-text" onClick={() => setSearchText("")}>
                  <X size={13} />
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={() => setSearchOpen((v) => !v)}
              title="Search"
              className={`p-1.5 rounded-md transition-colors shrink-0 ${
                searchText || searchOpen ? "bg-accent/15 text-accent" : "text-text-muted/60 hover:text-text hover:bg-elevated/40"
              }`}
            >
              <Search size={15} />
            </button>
          )}

          {/* Count */}
          {!tiny && (
            <span className="text-[12px] text-text-muted tabular-nums shrink-0 px-1.5">
              {filtered.length !== source.length ? `${filtered.length}/` : ""}{source.length}
            </span>
          )}

          {/* Pause */}
          <button
            title={paused ? `Resume (${pendingCount} buffered)` : "Pause"}
            className={`p-1.5 rounded-md transition-colors relative shrink-0 ${
              paused ? "bg-error/15 text-error" : "text-text-muted/60 hover:text-text hover:bg-elevated/40"
            }`}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
            {paused && pendingCount > 0 && (
              <span className="absolute -top-1.5 -right-1.5 text-[10px] font-bold bg-error text-text rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-0.5">
                {pendingCount > 99 ? "99+" : pendingCount}
              </span>
            )}
          </button>
        </div>

        {/* Compact: search drops to second row when active */}
        {compact && searchOpen && (
          <div className="px-3 pb-2 border-t border-border-subtle pt-2">
            <div className="relative flex items-center w-full">
              <Search size={13} className="absolute left-2.5 text-text-muted/50 pointer-events-none" />
              <input
                type="text"
                autoFocus
                placeholder="Filter events…"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                className="pl-8 pr-7 py-1.5 h-[32px] w-full text-[13px] bg-base border border-border rounded-md text-text placeholder:text-text-muted/50 outline-none focus:border-accent transition-colors"
              />
              {searchText && (
                <button className="absolute right-2 text-text-muted hover:text-text" onClick={() => setSearchText("")}>
                  <X size={13} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Log body ─────────────────────────────────────── */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto font-mono text-[13px] leading-[1.7]"
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

        {/* DB fallback — shown when search active and in-memory results empty */}
        {searchText.length >= 3 && filtered.length === 0 && (
          <div>
            {dbSearching && (
              <div className="text-text-muted/60 text-xs text-center py-4">Searching event log database…</div>
            )}
            {!dbSearching && dbQuery === searchText && dbResults.length === 0 && (
              <div className="text-text-muted/50 text-xs text-center py-4">No matches in database either.</div>
            )}
            {!dbSearching && dbResults.length > 0 && (
              <>
                <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-text-muted/60 border-y border-border-subtle">
                  <Database size={11} />
                  <span>Database — {dbResults.length} historical matches for "{dbQuery}"</span>
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

      {/* ── Scroll indicator ─────────────────────────────── */}
      {!autoScroll && !paused && (
        <button
          className="flex items-center justify-center gap-1.5 py-1.5 text-[12px] text-accent hover:text-accent-hover transition-colors"
          onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: "smooth" }) }}
        >
          <ArrowDown size={13} /> New events
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
        className={`flex items-baseline gap-2.5 py-[2px] px-3 ${
          log.error ? "bg-error-soft" : "hover:bg-overlay-1"
        } ${hasData ? "cursor-pointer" : ""}`}
        onClick={() => hasData && setExpanded((e) => !e)}
      >
        {/* Expand chevron */}
        <span className="shrink-0 w-3 flex items-center justify-center" style={{ color: msgColor, opacity: 0.3 }}>
          {hasData ? <ChevronRight size={11} className={`transition-transform ${expanded ? "rotate-90" : ""}`} /> : null}
        </span>
        {/* Timestamp */}
        <span className="shrink-0 text-[12px] tabular-nums" style={{ color: msgColor, opacity: 0.55 }}>
          {tiny ? log.timestamp?.slice(11, 19) : log.timestamp?.slice(11, 23)}
        </span>
        {/* Type label — muted, fixed width, clickable */}
        <button
          className="shrink-0 w-14 text-[12px] font-medium text-left truncate hover:opacity-70 transition-opacity text-text-muted"
          onClick={(e) => { e.stopPropagation(); setTypeFilters((prev) => { const next = new Set(prev); const t = log.type as EventType; if (next.has(t)) next.delete(t); else next.add(t); return next }) }}
        >
          {log.type}
        </button>
        {/* Event name — hidden on compact */}
        {!compact && (
          <span className="shrink-0 text-[12px] text-text-muted/40 whitespace-nowrap">
            {log.eventName ?? ""}
          </span>
        )}
        {/* Message — colored by type */}
        <span className="min-w-0 break-all" style={{ color: msgColor }}>
          {log.message}
        </span>
      </div>
      {expanded && log.data && (
        <div className={`${compact ? "pl-3 pr-3" : "pl-[6.5rem] pr-3"} py-1.5 bg-base border-l-2 border-border-subtle ml-3`}>
          <pre className="text-[11px] leading-[1.6] text-text-muted/70 whitespace-pre-wrap break-all">
            {JSON.stringify(log.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}
