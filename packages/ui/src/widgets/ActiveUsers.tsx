/**
 * ActiveUsers — admin observability: who's using mia and what happened.
 *
 * Features:
 *   - Summary stat strip (online / users / runs / tokens)
 *   - Main user table: sortable columns, text filter, all available data
 *   - Expandable per-user run history with pagination (offset/limit)
 *   - Server-side pagination for run history (supports 1000s of runs)
 *
 * Data sources (polled every 5s):
 *   GET /api/admin/users             — aggregated per-user stats
 *   GET /api/admin/active-runs       — currently executing runs
 *   GET /api/admin/users/:id/runs    — paginated run history per user
 */

import type { ReactNode } from "react"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import { ActiveUsersRunModal, type RunPreview } from "./ActiveUsersRunModal"

// ── Types ──────────────────────────────────────────────────────

interface UserRow {
  identifier: string
  upn: string | null
  displayName: string | null
  isAdmin: boolean
  sessionCount: number
  firstSeenAt: string
  lastSeenAt: string
  online: boolean
  lastIp: string | null
  lastUserAgent: string | null
  totalRuns: number
  runs24h: number
  runsFailed24h: number
  totalTokens24h: number
  totalLlmCalls24h: number
  lastRunAt: string | null
  lastModel: string | null
  activeRuns: number
}

interface UserSummary {
  users: number; online: number; runsInFlight: number; runs24h: number; tokens24h: number
}

interface ActiveRunRow {
  runId: string; goal: string; status: string
  upn: string | null; displayName: string | null; createdAt: string; stepCount: number
}

interface HistoryRow {
  runId: string; goal: string; status: string; stepCount: number
  createdAt: string; completedAt: string | null; durationMs: number | null
  totalTokens: number | null; llmCalls: number | null; model: string | null; error: string | null
}

interface HistoryState { rows: HistoryRow[]; total: number; offset: number; loading: boolean; error: boolean }

type SortKey = "name" | "upn" | "sessions" | "runs24h" | "failed24h" | "tokens24h" | "llmCalls24h" | "totalRuns" | "lastModel" | "firstSeen" | "lastSeen" | "status"
type SortDir = "asc" | "desc"

const PAGE_SIZE = 50

// Event types whose arrival means the user/run aggregates in this widget
// may have changed. Used to gate the SSE-driven refresh — we ignore the
// firehose of step/trace/token events and only react to lifecycle changes.
const REFRESH_EVENT_PREFIXES = ["run.", "session.", "user.", "notification."] as const
function isRefreshEvent(type: unknown): boolean {
  return typeof type === "string" && REFRESH_EVENT_PREFIXES.some((p) => type.startsWith(p))
}

// ── Sorting helpers ────────────────────────────────────────────

function getSortValue(u: UserRow, key: SortKey): string | number {
  switch (key) {
    case "name":       return (u.displayName ?? "").toLowerCase()
    case "upn":        return (u.upn ?? u.identifier).toLowerCase()
    case "sessions":   return u.sessionCount
    case "runs24h":    return u.runs24h
    case "failed24h":  return u.runsFailed24h
    case "tokens24h":  return u.totalTokens24h
    case "llmCalls24h":return u.totalLlmCalls24h
    case "totalRuns":  return u.totalRuns
    case "lastModel":  return (u.lastModel ?? "").toLowerCase()
    case "firstSeen":  return u.firstSeenAt
    case "lastSeen":   return u.lastSeenAt
    case "status":     return u.online ? 1 : u.activeRuns > 0 ? 0.5 : 0
  }
}

function sortUsers(users: UserRow[], key: SortKey, dir: SortDir): UserRow[] {
  return [...users].sort((a, b) => {
    const av = getSortValue(a, key)
    const bv = getSortValue(b, key)
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return dir === "asc" ? cmp : -cmp
  })
}

// ── Component ──────────────────────────────────────────────────

export function ActiveUsers(): ReactNode {
  const [users, setUsers] = useState<UserRow[]>([])
  const [summary, setSummary] = useState<UserSummary | null>(null)
  const [activeRuns, setActiveRuns] = useState<ActiveRunRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const connected = useStore((s) => s.connected)

  // Table state
  const [filter, setFilter] = useState("")
  const [sortKey, setSortKey] = useState<SortKey>("lastSeen")
  const [sortDir, setSortDir] = useState<SortDir>("desc")
  const [expanded, setExpanded] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, HistoryState>>({})
  // Extra filters
  const [statusFilter, setStatusFilter] = useState<"all" | "online" | "running" | "offline">("all")
  const [failedOnly, setFailedOnly] = useState(false)
  const [lastSeenRange, setLastSeenRange] = useState<"all" | "1h" | "24h" | "7d">("all")
  const [adminBusy, setAdminBusy] = useState<string | null>(null)
  const [runModal, setRunModal] = useState<{ runId: string; preview?: RunPreview } | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([
        fetch("/api/admin/users", { credentials: "include" }),
        fetch("/api/admin/active-runs", { credentials: "include" }),
      ])
      if (u.status === 403 || r.status === 403) { setError("Admin only"); setLoading(false); return }
      const uJson = (await u.json()) as { users: UserRow[]; summary: UserSummary }
      const rJson = (await r.json()) as { runs: ActiveRunRow[] }
      setUsers(uJson.users ?? [])
      setSummary(uJson.summary ?? null)
      setActiveRuns(rJson.runs ?? [])
      setError(null)
      setLoading(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }, [])

  // ── Run history (paginated) ──────────────────────────────────

  const loadHistory = useCallback(async (identifier: string, offset = 0) => {
    setHistory((h) => ({
      ...h,
      [identifier]: { rows: h[identifier]?.rows ?? [], total: h[identifier]?.total ?? 0, offset, loading: true, error: false },
    }))
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(identifier)}/runs?limit=${PAGE_SIZE}&offset=${offset}`,
        { credentials: "include" },
      )
      if (!res.ok) throw new Error("failed")
      const json = (await res.json()) as { runs: HistoryRow[]; total: number }
      setHistory((h) => ({
        ...h,
        [identifier]: { rows: json.runs ?? [], total: json.total ?? 0, offset, loading: false, error: false },
      }))
    } catch {
      setHistory((h) => ({
        ...h,
        [identifier]: { ...h[identifier], loading: false, error: true },
      }))
    }
  }, [])

  const toggle = useCallback((identifier: string) => {
    setExpanded((cur) => {
      const next = cur === identifier ? null : identifier
      if (next && !history[next]) void loadHistory(next, 0)
      return next
    })
  }, [history, loadHistory])

  const toggleAdmin = useCallback(async (user: UserRow, next: boolean) => {
    if (!user.upn) return
    setAdminBusy(user.identifier)
    try {
      await api.setUserAdmin(user.identifier, next)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdminBusy(null)
    }
  }, [refresh])

  // Refs mirror the latest expanded/history values so the SSE-driven effect
  // below can read them without listing them as dependencies. Putting
  // `history` (or the `loadHistory` callback, which closes over setHistory)
  // in the deps array would cause: event → loadHistory → setHistory →
  // history identity changes → effect re-runs → fetch — an unbounded loop
  // that exhausts the browser socket pool (ERR_INSUFFICIENT_RESOURCES).
  const expandedRef = useRef<string | null>(null)
  const historyRef = useRef(history)
  const loadHistoryRef = useRef(loadHistory)
  useEffect(() => { expandedRef.current = expanded }, [expanded])
  useEffect(() => { historyRef.current = history }, [history])
  useEffect(() => { loadHistoryRef.current = loadHistory }, [loadHistory])

  const refreshExpandedHistory = useCallback(() => {
    const exp = expandedRef.current
    if (!exp) return
    const offset = historyRef.current[exp]?.offset ?? 0
    void loadHistoryRef.current(exp, offset)
  }, [])

  // SSE-driven refresh: count the lifecycle events we care about and re-run
  // the fetch whenever that count changes. No polling — the only periodic
  // refresh in this widget used to be a 5s setInterval; it has been removed.
  const refreshTick = useStore((s) => s.sseEventLog.filter((e) => isRefreshEvent(e.type)).length)

  useEffect(() => {
    void refresh()
    refreshExpandedHistory()
  }, [refresh, refreshTick, refreshExpandedHistory])

  useEffect(() => {
    if (!connected) return
    void refresh()
    refreshExpandedHistory()
  }, [connected, refresh, refreshExpandedHistory])

  useEffect(() => {
    const refreshVisibleData = () => {
      if (document.visibilityState !== "visible") return
      void refresh()
      refreshExpandedHistory()
    }

    const interval = window.setInterval(refreshVisibleData, 30_000)
    document.addEventListener("visibilitychange", refreshVisibleData)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", refreshVisibleData)
    }
  }, [refresh, refreshExpandedHistory])

  // ── Derived data ─────────────────────────────────────────────

  const runsByIdentifier = useMemo(() => {
    const m = new Map<string, ActiveRunRow[]>()
    for (const r of activeRuns) {
      const key = r.upn
      if (!key) continue
      const list = m.get(key) ?? []
      list.push(r)
      m.set(key, list)
    }
    return m
  }, [activeRuns])

  const filteredSorted = useMemo(() => {
    let list = users
    if (filter) {
      const q = filter.toLowerCase()
      list = list.filter((u) =>
        (u.displayName ?? "").toLowerCase().includes(q) ||
        (u.upn ?? "").toLowerCase().includes(q) ||
        u.identifier.toLowerCase().includes(q) ||
        (u.lastModel ?? "").toLowerCase().includes(q) ||
        (u.lastIp ?? "").includes(q)
      )
    }
    if (statusFilter !== "all") {
      list = list.filter((u) => {
        const liveCount = runsByIdentifier.get(u.identifier)?.length ?? 0
        if (statusFilter === "online") return u.online
        if (statusFilter === "running") return liveCount > 0 || u.activeRuns > 0
        if (statusFilter === "offline") return !u.online
        return true
      })
    }
    if (failedOnly) list = list.filter((u) => u.runsFailed24h > 0)
    if (lastSeenRange !== "all") {
      const cutoff = Date.now() - ({ "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000 } as Record<string, number>)[lastSeenRange]
      list = list.filter((u) => parseUtc(u.lastSeenAt) >= cutoff)
    }
    return sortUsers(list, sortKey, sortDir)
  }, [users, filter, sortKey, sortDir, statusFilter, failedOnly, lastSeenRange, runsByIdentifier])

  // ── Sort click handler ───────────────────────────────────────

  const onSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"))
        return prev
      }
      setSortDir(key === "name" || key === "upn" || key === "lastModel" ? "asc" : "desc")
      return key
    })
  }, [])

  if (loading) return <div className="active-users-widget text-text-muted p-4">Loading…</div>
  if (error)   return <div className="active-users-widget text-error p-4">{error}</div>

  return (
    <div className="active-users-widget h-full flex flex-col overflow-hidden">
      {/* Stat strip */}
      {summary && (
        <div className="shrink-0 border-b border-border-subtle">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-border-subtle">
            <Stat label="Online"         value={String(summary.online)}        accent={summary.online > 0 ? "emerald" : undefined} />
            <Stat label="Users (7d)"     value={String(summary.users)} />
            <Stat label="Runs in flight" value={String(summary.runsInFlight)}  accent={summary.runsInFlight > 0 ? "blue" : undefined} />
            <Stat label="Runs (24h)"     value={String(summary.runs24h)} />
            <Stat label="Tokens (24h)"   value={formatCompact(summary.tokens24h)} />
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="shrink-0 px-3 py-2 border-b border-border-subtle flex flex-wrap items-center gap-2">
        <input
          className="flex-1 min-w-[180px] bg-transparent text-text placeholder:text-text-muted/50 outline-none border border-border-subtle rounded-md px-2.5 py-1.5 focus:border-accent/50"
          placeholder="Filter by name, UPN, IP, model…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
        {/* Status filter */}
        <div className="flex items-center gap-0.5 shrink-0">
          {(["all", "online", "running", "offline"] as const).map((s) => (
            <button key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-2 py-1 rounded-md transition-colors ${
                statusFilter === s
                  ? "bg-accent/15 text-accent"
                  : "text-text-muted hover:text-text hover:bg-overlay-2"
              }`}
            >{s}</button>
          ))}
        </div>
        {/* Failed-only toggle */}
        <button
          onClick={() => setFailedOnly((v) => !v)}
          className={`px-2 py-1 rounded-md transition-colors shrink-0 ${
            failedOnly ? "bg-error-soft text-error" : "text-text-muted hover:text-text hover:bg-overlay-2"
          }`}
        >failed only</button>
        {/* Last seen range */}
        <div className="flex items-center gap-0.5 shrink-0">
          {(["all", "1h", "24h", "7d"] as const).map((r) => (
            <button key={r}
              onClick={() => setLastSeenRange(r)}
              className={`px-2 py-1 rounded-md transition-colors ${
                lastSeenRange === r
                  ? "bg-accent/15 text-accent"
                  : "text-text-muted hover:text-text hover:bg-overlay-2"
              }`}
            >{r === "all" ? "any time" : `last ${r}`}</button>
          ))}
        </div>
        <span className="au-label tabular-nums shrink-0 ml-auto">
          {filteredSorted.length} {filteredSorted.length === 1 ? "user" : "users"}
        </span>
      </div>

      {/* Scrollable table — responsive column hiding kicks in at narrow
          widths so the essential cols (status / name / UPN) always fit
          without horizontal scroll, while richer metrics progressively
          appear at sm/md/lg/xl. The container still allows
          overflow-auto as a last-resort fallback. */}
      <div className="flex-1 min-h-0 au-table-scroll overflow-auto">
        <table className="au-users-table w-full border-collapse">
          <colgroup>
            <col className="w-8" />
            <col style={{ width: "16%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "8%" }} />
            <col style={{ width: "7%" }} />
            <col style={{ width: "10%" }} />
            <col style={{ width: "9%" }} />
            <col style={{ width: "9%" }} />
            <col className="w-6" />
          </colgroup>
          <thead className="sticky top-0 z-20 bg-surface">
            <tr className="text-left text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle">
              <SortTh k="status"     current={sortKey} dir={sortDir} onClick={onSort} className="w-8"    label="" />
              <SortTh k="name"       current={sortKey} dir={sortDir} onClick={onSort}                     label="Name" />
              <SortTh k="upn"        current={sortKey} dir={sortDir} onClick={onSort}                     label="UPN / Session" />
              <SortTh k="sessions"   current={sortKey} dir={sortDir} onClick={onSort} className="text-right hidden sm:table-cell" label="Sessions" />
              <SortTh k="totalRuns"  current={sortKey} dir={sortDir} onClick={onSort} className="text-right hidden md:table-cell" label="Total Runs" />
              <SortTh k="runs24h"    current={sortKey} dir={sortDir} onClick={onSort} className="text-right hidden sm:table-cell" label="Runs 24h" />
              <SortTh k="failed24h"  current={sortKey} dir={sortDir} onClick={onSort} className="text-right hidden lg:table-cell" label="Failed 24h" />
              <SortTh k="tokens24h"  current={sortKey} dir={sortDir} onClick={onSort} className="text-right hidden md:table-cell" label="Tokens 24h" />
              <SortTh k="llmCalls24h" current={sortKey} dir={sortDir} onClick={onSort} className="text-right hidden lg:table-cell" label="LLM Calls" />
              <SortTh k="lastModel"  current={sortKey} dir={sortDir} onClick={onSort} className="hidden lg:table-cell"             label="Model" />
              <SortTh k="firstSeen"  current={sortKey} dir={sortDir} onClick={onSort} className="hidden xl:table-cell"             label="First Seen" />
              <SortTh k="lastSeen"   current={sortKey} dir={sortDir} onClick={onSort} className="hidden xl:table-cell"             label="Last Seen" />
              <th className="py-2 px-3 text-xs w-6 hidden sm:table-cell bg-surface" />
            </tr>
          </thead>
          <tbody>
            {filteredSorted.map((u) => {
              const live = runsByIdentifier.get(u.identifier) ?? []
              const isOpen = expanded === u.identifier
              const hist = history[u.identifier]
              return (
                <Fragment key={u.identifier}>
                  <tr
                    className={`border-b border-border-subtle cursor-pointer hover:bg-overlay-2 transition-colors ${isOpen ? "bg-overlay-2" : ""}`}
                    onClick={() => toggle(u.identifier)}
                  >
                    {/* Status */}
                    <td className="py-2 px-3">
                      {live.length > 0 ? (
                        <span className="inline-block w-2 h-2 rounded-full bg-info animate-pulse" title={`${live.length} running`} />
                      ) : (
                        <span className={`inline-block w-2 h-2 rounded-full ${u.online ? "bg-success" : "bg-text-muted/40"}`}
                              title={u.online ? "online" : "offline"} />
                      )}
                    </td>
                    {/* Name */}
                    <td className="py-2 px-3 text-text whitespace-nowrap">
                      {u.displayName ?? <span className="text-text-muted/60">—</span>}
                      {u.isAdmin ? (
                        <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 au-label font-semibold text-accent">
                          admin
                        </span>
                      ) : null}
                      {u.runsFailed24h > 0 && (
                        <span className="ml-2 text-error">{u.runsFailed24h} fail</span>
                      )}
                    </td>
                    {/* UPN */}
                    <td className="py-2 px-3 font-mono text-text-muted whitespace-nowrap select-text cursor-text" onClick={(e) => e.stopPropagation()}>
                      {u.upn ?? (() => {
                        const isName = u.identifier.startsWith("name:")
                        const short  = isName ? u.identifier.slice(5) : u.identifier.slice(4, 20)
                        return <span title={isName ? u.identifier.slice(5) : u.identifier.slice(4)}>anon · {short}</span>
                      })()}
                      <CopyBtn value={u.upn ?? u.identifier} label="UPN" />
                    </td>
                    {/* Sessions */}
                    <td className="py-2 px-3 text-right tabular-nums text-text-muted hidden sm:table-cell">{u.sessionCount}</td>
                    {/* Total Runs */}
                    <td className="py-2 px-3 text-right tabular-nums text-text hidden md:table-cell">
                      {u.totalRuns > 0 ? u.totalRuns : <span className="text-text-muted/50">0</span>}
                    </td>
                    {/* Runs 24h */}
                    <td className="py-2 px-3 text-right tabular-nums text-text hidden sm:table-cell">
                      {u.runs24h > 0 ? u.runs24h : <span className="text-text-muted/50">0</span>}
                    </td>
                    {/* Failed 24h */}
                    <td className="py-2 px-3 text-right tabular-nums hidden lg:table-cell">
                      {u.runsFailed24h > 0
                        ? <span className="text-error">{u.runsFailed24h}</span>
                        : <span className="text-text-muted/50">0</span>}
                    </td>
                    {/* Tokens 24h */}
                    <td className="py-2 px-3 text-right tabular-nums text-text-muted hidden md:table-cell">
                      {u.totalTokens24h > 0 ? formatCompact(u.totalTokens24h) : <span className="text-text-muted/50">0</span>}
                    </td>
                    {/* LLM Calls 24h */}
                    <td className="py-2 px-3 text-right tabular-nums text-text-muted hidden lg:table-cell">
                      {u.totalLlmCalls24h > 0 ? u.totalLlmCalls24h : <span className="text-text-muted/50">0</span>}
                    </td>
                    {/* Model */}
                    <td className="py-2 px-3 text-text-muted whitespace-nowrap hidden lg:table-cell">
                      {u.lastModel ?? <span className="text-text-muted/50">—</span>}
                    </td>
                    {/* First Seen */}
                    <td className="py-2 px-3 text-text-muted whitespace-nowrap hidden xl:table-cell" title={u.firstSeenAt}>
                      {formatRelative(u.firstSeenAt)}
                    </td>
                    {/* Last Seen */}
                    <td className="py-2 px-3 text-text-muted whitespace-nowrap hidden xl:table-cell" title={u.lastSeenAt}>
                      {formatRelative(u.lastSeenAt)}
                    </td>
                    {/* Expand arrow */}
                    <td className="py-2 px-3 text-text-muted hidden sm:table-cell">{isOpen ? "▾" : "▸"}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-overlay-1">
                      <td colSpan={13} className="w-0 min-w-0 p-0 align-top">
                        <UserDetail
                          user={u}
                          liveRuns={live}
                          history={hist}
                          adminBusy={adminBusy === u.identifier}
                          onToggleAdmin={(next) => void toggleAdmin(u, next)}
                          onPageChange={(offset) => void loadHistory(u.identifier, offset)}
                          onCollapse={() => toggle(u.identifier)}
                          onRunClick={(runId, preview) => setRunModal({ runId, preview })}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {filteredSorted.length === 0 && (
              <tr><td colSpan={13} className="py-8 text-center text-text-muted">
                {filter ? "No users match filter." : "No sessions yet."}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {runModal && (
        <ActiveUsersRunModal
          runId={runModal.runId}
          preview={runModal.preview}
          onClose={() => setRunModal(null)}
        />
      )}
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────

function SortTh({ k, current, dir, onClick, label, className }: {
  k: SortKey; current: SortKey; dir: SortDir; onClick: (k: SortKey) => void
  label: string; className?: string
}) {
  const active = current === k
  return (
    <th
      className={`py-2 px-3 text-xs font-semibold cursor-pointer select-none hover:text-text transition-colors bg-surface ${active ? "text-text" : ""} ${className ?? ""}`}
      onClick={() => onClick(k)}
      title={label ? (active ? (dir === "asc" ? "Sort descending ↓" : "Sort ascending ↑") : `Sort by ${label}`) : undefined}
    >
      {label}
      {label && (
        <span className={`ml-1 ${active ? "text-accent" : "text-text-muted/25"}`}>
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      )}
    </th>
  )
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "emerald" | "blue" }) {
  const dot =
    accent === "emerald" ? "bg-success"
    : accent === "blue"  ? "bg-info"
    : null
  const valueColor =
    accent === "emerald" ? "text-success"
    : accent === "blue"  ? "text-info"
    : "text-text"
  return (
    <div className="px-4 py-3 flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        {dot && <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot} ${accent === "emerald" ? "animate-pulse" : ""}`} />}
        <span className={`au-stat-value tabular-nums ${valueColor}`}>{value}</span>
      </div>
      <div className="au-label tracking-wider">{label}</div>
    </div>
  )
}

// ── User Detail (expanded row) ─────────────────────────────────

type RunSortKey = "started" | "duration" | "steps" | "tokens" | "llmCalls" | "model" | "status"

function UserDetail({ user, liveRuns, history, adminBusy, onToggleAdmin, onPageChange, onCollapse, onRunClick }: {
  user: UserRow; liveRuns: ActiveRunRow[]
  history: HistoryState | undefined
  adminBusy: boolean
  onToggleAdmin: (next: boolean) => void
  onPageChange: (offset: number) => void
  onCollapse: () => void
  onRunClick: (runId: string, preview?: RunPreview) => void
}) {
  const [runFilter, setRunFilter] = useState("")
  const [runStatus, setRunStatus] = useState<"all" | "succeeded" | "failed" | "running">("all")
  const [runSort, setRunSort] = useState<RunSortKey>("started")
  const [runSortDir, setRunSortDir] = useState<SortDir>("desc")

  const onRunSort = (k: RunSortKey) => {
    if (k === runSort) { setRunSortDir((d) => d === "asc" ? "desc" : "asc"); return }
    setRunSortDir(k === "model" ? "asc" : "desc")
    setRunSort(k)
  }

  const displayRows = useMemo(() => {
    if (!history?.rows.length) return []
    let rows = history.rows
    // text filter on goal + run id
    if (runFilter) {
      const q = runFilter.toLowerCase()
      rows = rows.filter((r) =>
        r.goal.toLowerCase().includes(q) ||
        r.runId.toLowerCase().includes(q) ||
        (r.model ?? "").toLowerCase().includes(q) ||
        (r.error ?? "").toLowerCase().includes(q)
      )
    }
    // status filter
    if (runStatus !== "all") {
      rows = rows.filter((r) => {
        if (runStatus === "succeeded") return r.status === "succeeded" || r.status === "completed"
        if (runStatus === "failed")    return r.status === "failed" || r.status === "error" || r.status === "timeout"
        if (runStatus === "running")   return r.status === "running" || r.status === "pending" || r.status === "planning"
        return true
      })
    }
    // sort
    rows = [...rows].sort((a, b) => {
      let av: string | number, bv: string | number
      switch (runSort) {
        case "started":  av = a.createdAt;         bv = b.createdAt;         break
        case "duration": av = a.durationMs ?? -1;  bv = b.durationMs ?? -1;  break
        case "steps":    av = a.stepCount;          bv = b.stepCount;         break
        case "tokens":   av = a.totalTokens ?? -1; bv = b.totalTokens ?? -1; break
        case "llmCalls": av = a.llmCalls ?? -1;    bv = b.llmCalls ?? -1;    break
        case "model":    av = a.model ?? "";        bv = b.model ?? "";       break
        case "status":   av = a.status;             bv = b.status;            break
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return runSortDir === "asc" ? cmp : -cmp
    })
    return rows
  }, [history?.rows, runFilter, runStatus, runSort, runSortDir])

  const RSortTh = ({ k, label, right }: { k: RunSortKey; label: string; right?: boolean }) => {
    const active = runSort === k
    return (
      <th
        className={`py-2 px-3 au-label font-semibold cursor-pointer select-none whitespace-nowrap transition-colors bg-canvas ${active ? "text-text" : "text-text-muted/50 hover:text-text-muted"} ${right ? "text-right" : "text-left"}`}
        onClick={() => onRunSort(k)}
      >
        {label}
        <span className={`ml-0.5 ${active ? "text-accent" : "text-text-muted/20"}`}>
          {active ? (runSortDir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </th>
    )
  }

  return (
    <div className="au-detail-panel min-w-0 border-t border-border-subtle bg-overlay-1">

      {/* Collapse handle — sits flush under the parent row */}
      <button
        type="button"
        className="au-detail-header flex w-full items-center gap-2.5 px-4 py-2.5 text-left bg-overlay-2/80 hover:bg-overlay-2 border-b border-border-subtle transition-colors"
        onClick={onCollapse}
        title="Collapse user details"
      >
        <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${
          liveRuns.length > 0 ? "bg-info animate-pulse"
          : user.online ? "bg-success"
          : "bg-text-muted/40"
        }`} />
        <span className="font-medium text-text truncate">
          {user.displayName ?? <span className="text-text-muted">—</span>}
        </span>
        {user.isAdmin ? (
          <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 au-label font-semibold text-accent">
            admin
          </span>
        ) : null}
        {user.upn ? (
          <span className="min-w-0 truncate font-mono text-sm text-text-muted">{user.upn}</span>
        ) : (
          <span className="font-mono text-sm text-text-muted/60">anon · {user.identifier.slice(4, 12)}</span>
        )}
        <span className="ml-auto shrink-0 au-label text-text-muted">collapse ▾</span>
      </button>

      {/* Identity — labeled grid, not a faux table row */}
      <div className="au-detail-meta px-4 py-3 border-b border-border-subtle">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-x-5 gap-y-3">
          <KV label="Role" value={user.isAdmin ? "Admin" : "User"} />
          <KV label="First seen" value={formatAbsolute(user.firstSeenAt)} />
          <KV label="Last seen" value={formatAbsolute(user.lastSeenAt)} />
          <KV label="Sessions" value={String(user.sessionCount)} />
          <KV label="Total runs" value={String(user.totalRuns)} />
          <KV label="Runs 24h" value={String(user.runs24h)} />
          <KV label="Failed 24h" value={String(user.runsFailed24h)} />
          <KV label="Tokens 24h" value={user.totalTokens24h > 0 ? formatCompact(user.totalTokens24h) : "0"} />
          <KV label="LLM calls 24h" value={String(user.totalLlmCalls24h)} />
          <KV label="Last run" value={user.lastRunAt ? formatRelative(user.lastRunAt) : "—"} />
          <KV label="Last IP" value={user.lastIp ?? "—"} mono />
          <KV label="Last model" value={user.lastModel ?? "—"} mono />
        </div>
        {user.lastUserAgent ? (
          <div className="mt-3 pt-3 border-t border-border-subtle/60">
            <div className="au-detail-kv">
              <span className="au-detail-kv__label">User agent</span>
              <span className="au-detail-kv__value font-mono text-xs text-text-muted break-all" title={user.lastUserAgent}>
                {user.lastUserAgent}
              </span>
            </div>
          </div>
        ) : null}
        {user.upn ? (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={adminBusy}
              onClick={(e) => {
                e.stopPropagation()
                onToggleAdmin(!user.isAdmin)
              }}
              className="rounded-md border border-border-subtle px-3 py-1.5 text-sm text-text-muted hover:bg-overlay-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
              title={user.isAdmin ? "Revoke platform admin role" : "Grant platform admin role"}
            >
              {adminBusy ? "Saving…" : user.isAdmin ? "Revoke admin" : "Grant admin"}
            </button>
          </div>
        ) : null}
      </div>

      {/* ── Live runs (when present) ──────────────────── */}
      {liveRuns.length > 0 && (
        <div className="px-4 py-2.5 border-b border-border-subtle flex flex-col gap-1">
          <div className="au-label font-semibold text-success tracking-widest mb-1">Running now</div>
          {liveRuns.map((r) => (
            <button
              key={r.runId}
              type="button"
              className="flex w-full items-baseline gap-3 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-overlay-2"
              onClick={(e) => {
                e.stopPropagation()
                onRunClick(r.runId, {
                  goal: r.goal,
                  status: r.status,
                  stepCount: r.stepCount,
                  createdAt: r.createdAt,
                })
              }}
            >
              <span className="font-mono text-text-muted/60 shrink-0">{r.runId.slice(0, 8)}</span>
              <span className="text-text-muted/60 shrink-0">step {r.stepCount}</span>
              <span className="truncate text-text">{r.goal}</span>
            </button>
          ))}
        </div>
      )}

      {/* ── Run history ───────────────────────────────── */}
      <div>
        {/* Toolbar */}
        <div className="px-4 py-2 border-b border-border-subtle flex flex-wrap items-center gap-2 bg-overlay-1">
          <span className="au-label font-semibold text-text-muted/60 tracking-widest shrink-0">
            Runs
          </span>
          {history && !history.loading && (
            <span className="au-label text-text-muted/40 shrink-0">
              {history.total}{displayRows.length !== history.rows.length ? ` · ${displayRows.length} shown` : ""}
            </span>
          )}
          <div className="w-px h-3 bg-overlay-3 shrink-0" />
          <input
            className="flex-1 min-w-[140px] bg-transparent text-text placeholder:text-text-muted/30 outline-none"
            placeholder="filter goal, run ID, model, error…"
            value={runFilter}
            onChange={(e) => setRunFilter(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            spellCheck={false}
          />
          <div className="flex items-center gap-0.5 shrink-0">
            {(["all", "succeeded", "failed", "running"] as const).map((s) => (
              <button key={s}
                onClick={(e) => { e.stopPropagation(); setRunStatus(s) }}
                className={`px-2 py-0.5 rounded-md transition-colors ${
                  runStatus === s
                    ? s === "failed"    ? "bg-error-soft text-error"
                    : s === "succeeded" ? "bg-success-soft text-success"
                    : s === "running"   ? "bg-info-soft text-info"
                    : "bg-overlay-3 text-text"
                    : "text-text-muted/50 hover:text-text-muted"
                }`}
              >{s}</button>
            ))}
          </div>
          {history && history.total > PAGE_SIZE && (
            <Pagination
              offset={history.offset}
              total={history.total}
              pageSize={PAGE_SIZE}
              onChange={onPageChange}
              loading={history.loading}
            />
          )}
        </div>

        {/* States */}
        {history?.loading && !history.rows.length && (
          <div className="px-4 py-3 text-text-muted/50">Loading…</div>
        )}
        {history?.error && (
          <div className="px-4 py-3 text-error">Failed to load history.</div>
        )}
        {history && !history.loading && history.rows.length === 0 && !history.error && (
          <div className="px-4 py-3 text-text-muted/40">No runs yet.</div>
        )}

        {/* Table */}
        {history && history.rows.length > 0 && (
          <div>
          <table className={`w-full border-collapse ${history.loading ? "opacity-40" : ""}`}>
            <thead className="sticky top-0 z-[16] bg-canvas">
              <tr className="bg-canvas">
                <th className="py-2 px-3 w-6 bg-canvas" onClick={() => onRunSort("status")} />
                <th className="py-2 px-3 text-left au-label font-semibold text-text-muted/50 cursor-default bg-canvas">Run</th>
                <RSortTh k="started"  label="Started" />
                <RSortTh k="duration" label="Duration" right />
                <RSortTh k="steps"    label="Steps" right />
                <RSortTh k="tokens"   label="Tokens" right />
                <RSortTh k="llmCalls" label="LLM Calls" right />
                <RSortTh k="model"    label="Model" />
                <th className="py-2 px-3 text-left au-label font-semibold text-text-muted/50 cursor-default bg-canvas">Goal</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.length === 0 ? (
                <tr><td colSpan={9} className="py-5 text-center text-text-muted/40">No runs match filter.</td></tr>
              ) : displayRows.map((h) => (
                <tr
                  key={h.runId}
                  className="border-t border-border-subtle cursor-pointer transition-colors hover:bg-overlay-2"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRunClick(h.runId, {
                      goal: h.goal,
                      status: h.status,
                      model: h.model,
                      stepCount: h.stepCount,
                      totalTokens: h.totalTokens,
                      llmCalls: h.llmCalls,
                      error: h.error,
                      createdAt: h.createdAt,
                      completedAt: h.completedAt,
                      durationMs: h.durationMs,
                    })
                  }}
                >
                  <td className="py-2 px-3"><StatusDot status={h.status} /></td>
                  <td
                    className="py-2 px-3 font-mono text-text-muted/70 select-text"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {h.runId.slice(0, 8)}<CopyBtn value={h.runId} label="run ID" />
                  </td>
                  <td className="py-2 px-3 text-text-muted/70 whitespace-nowrap" title={h.createdAt}>{formatRelative(h.createdAt)}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-text-muted/70">{formatDuration(h.durationMs)}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-text-muted/70">{h.stepCount}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-text-muted/70">{h.totalTokens != null ? formatCompact(h.totalTokens) : <span className="text-text-muted/30">—</span>}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-text-muted/70">{h.llmCalls ?? <span className="text-text-muted/30">—</span>}</td>
                  <td className="py-2 px-3 text-text-muted/70 whitespace-nowrap">{h.model ?? <span className="text-text-muted/30">—</span>}</td>
                  <td className="py-2 px-3 max-w-[320px] select-text cursor-text" onClick={(e) => e.stopPropagation()}>
                    <span className="block truncate" title={h.error ? `${h.goal}\n\nError: ${h.error}` : h.goal}>
                      {h.error && <span className="text-error/90 mr-1.5" title={h.error}>⚠</span>}
                      <span className={h.error ? "text-text-muted/70" : "text-text"}>{h.goal}</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pagination ─────────────────────────────────────────────────

function Pagination({ offset, total, pageSize, onChange, loading }: {
  offset: number; total: number; pageSize: number
  onChange: (offset: number) => void; loading: boolean
}) {
  const page = Math.floor(offset / pageSize) + 1
  const pages = Math.ceil(total / pageSize)
  return (
    <div className="flex items-center gap-2 text-text-muted">
      <button
        className="px-1.5 py-0.5 rounded hover:bg-overlay-3 disabled:opacity-30 disabled:cursor-default"
        disabled={offset === 0 || loading}
        onClick={(e) => { e.stopPropagation(); onChange(0) }}
        title="First page"
      >«</button>
      <button
        className="px-1.5 py-0.5 rounded hover:bg-overlay-3 disabled:opacity-30 disabled:cursor-default"
        disabled={offset === 0 || loading}
        onClick={(e) => { e.stopPropagation(); onChange(Math.max(0, offset - pageSize)) }}
      >‹</button>
      <span className="tabular-nums">
        {page} <span className="text-text-muted/50">/ {pages}</span>
      </span>
      <button
        className="px-1.5 py-0.5 rounded hover:bg-overlay-3 disabled:opacity-30 disabled:cursor-default"
        disabled={offset + pageSize >= total || loading}
        onClick={(e) => { e.stopPropagation(); onChange(offset + pageSize) }}
      >›</button>
      <button
        className="px-1.5 py-0.5 rounded hover:bg-overlay-3 disabled:opacity-30 disabled:cursor-default"
        disabled={offset + pageSize >= total || loading}
        onClick={(e) => { e.stopPropagation(); onChange((pages - 1) * pageSize) }}
        title="Last page"
      >»</button>
    </div>
  )
}

// ── Small components ───────────────────────────────────────────

/** Compact key/value pair for the identity strip. */
function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="au-detail-kv min-w-0">
      <span className="au-detail-kv__label">{label}</span>
      <span className={`au-detail-kv__value ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  )
}

function CopyBtn({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }}
      className="ml-1 text-text-muted/30 hover:text-accent transition-colors"
      title={`Copy ${label ?? value}`}
    >
      {copied ? "✓" : "⎘"}
    </button>
  )
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded" || status === "completed" ? "bg-success"
    : status === "running" || status === "pending" || status === "planning" ? "bg-info animate-pulse"
    : status === "error" || status === "failed" || status === "timeout" ? "bg-error"
    : "bg-text-muted/40"
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={status} />
}

// ── Formatters ──────────────────────────────────────────────────

function parseUtc(iso: string | null | undefined): number {
  if (!iso) return NaN
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) return Date.parse(iso)
  const normalised = iso.includes("T") ? iso : iso.replace(" ", "T")
  return Date.parse(normalised + "Z")
}

function formatRelative(iso: string | null | undefined): string {
  const then = parseUtc(iso)
  if (!Number.isFinite(then)) return "—"
  const diffSec = Math.floor((Date.now() - then) / 1000)
  if (diffSec < 0)     return "just now"
  if (diffSec < 60)    return `${diffSec}s ago`
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  return `${Math.floor(diffSec / 86400)}d ago`
}

function formatAbsolute(iso: string | null | undefined): string {
  const t = parseUtc(iso)
  if (!Number.isFinite(t)) return "—"
  return new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  if (ms < 1000)   return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m${s.toString().padStart(2, "0")}s`
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
  return `${(n / 1_000_000_000).toFixed(1)}B`
}
