/**
 * ActiveUsers — admin observability: who's using mia and what happened.
 *
 * Features:
 *   - Summary stat strip (online / users / runs / tokens)
 *   - Main user table: sortable columns, text filter, all available data
 *   - Expandable per-user run history with pagination (offset/limit)
 *   - Server-side pagination for run history (supports 1000s of runs)
 *
 * Data sources (SSE-driven, no polling):
 *   GET /api/admin/users             — aggregated per-user stats
 *   GET /api/admin/active-runs       — currently executing runs
 *   GET /api/admin/users/:id/runs    — paginated run history per user
 *
 * Summary + active runs refresh on run lifecycle events and
 * `session.presence.tick`. Expanded run history reloads silently only when
 * a run is queued or reaches a terminal state — never on presence ticks or
 * step events, so the table does not flash while an agent is working.
 */

import type { ReactNode } from "react"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../client/index"
import { EmptyState } from "../components/EmptyState"
import { useContainerSize } from "../hooks/useContainerSize"
import { ToastStack, useWidgetToasts } from "../components/useWidgetToasts"
import { useStore } from "../state/store"
import { ActiveUsersRunModal, type RunPreview } from "./ActiveUsersRunModal"
import { WIDGET_ICONS } from "./widget-icons"
import {
  WidgetToolbarFilterMenu,
  WidgetToolbarFilterMenuItem,
} from "./widget-toolbar"
import {
  isActiveRunStepEvent,
  isHistoryRefreshEvent,
  isSummaryRefreshEvent,
  useAdminSseEvents,
} from "./active-users-sse"

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

/**
 * Layout rules (container width, not viewport):
 * 1. Never crush a 13-column table into a narrow panel.
 * 2. Never clip columns behind overflow — that is not responsiveness.
 * 3. Stack (cards) is the default. Table only when every column fits
 *    comfortably with no horizontal scroll.
 */
const AU_TABLE_MIN_WIDTH_PX = 1200
const AU_TABLE_COL_SPAN = 13

const SORT_LABELS: Record<SortKey, string> = {
  status: "Status",
  name: "Name",
  upn: "UPN",
  sessions: "Sessions",
  totalRuns: "Total Runs",
  runs24h: "Runs 24h",
  failed24h: "Failed 24h",
  tokens24h: "Tokens 24h",
  llmCalls24h: "LLM Calls",
  lastModel: "Model",
  firstSeen: "First Seen",
  lastSeen: "Last Seen",
}

function readSseRunId(data: Record<string, unknown>): string | null {
  const runId = data["runId"]
  return typeof runId === "string" && runId.length > 0 ? runId : null
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
  const { toasts, dismissToast, notifyError } = useWidgetToasts()
  const [users, setUsers] = useState<UserRow[]>([])
  const [summary, setSummary] = useState<UserSummary | null>(null)
  const [activeRuns, setActiveRuns] = useState<ActiveRunRow[]>([])
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
  const rootRef = useRef<HTMLDivElement>(null)
  const { width: widgetWidth } = useContainerSize(rootRef)
  // Stack by default (including before first measure). Table only when fully fits.
  const useStack = widgetWidth < AU_TABLE_MIN_WIDTH_PX
  // Filters collapse whenever we stack — chips fight for width on mid-size panels.
  const compact = useStack || widgetWidth < 860
  const tiny = widgetWidth > 0 && widgetWidth < 480

  const refreshSummary = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([
        fetch("/api/admin/users", { credentials: "include", signal: AbortSignal.timeout(60_000) }),
        fetch("/api/admin/active-runs", { credentials: "include", signal: AbortSignal.timeout(60_000) }),
      ])
      if (u.status === 403 || r.status === 403) { notifyError("Admin only"); setLoading(false); return }
      const uJson = (await u.json()) as { users: UserRow[]; summary: UserSummary }
      const rJson = (await r.json()) as { runs: ActiveRunRow[] }
      setUsers(uJson.users ?? [])
      setSummary(uJson.summary ?? null)
      setActiveRuns(rJson.runs ?? [])
      setLoading(false)
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }, [notifyError])

  // ── Run history (paginated) ──────────────────────────────────

  const loadHistory = useCallback(async (identifier: string, offset = 0, opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true
    setHistory((h) => {
      const prev = h[identifier]
      if (silent && prev?.rows.length) {
        return { ...h, [identifier]: { ...prev, offset, error: false } }
      }
      return {
        ...h,
        [identifier]: {
          rows: prev?.rows ?? [],
          total: prev?.total ?? 0,
          offset,
          loading: true,
          error: false,
        },
      }
    })
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(identifier)}/runs?limit=${PAGE_SIZE}&offset=${offset}`,
        { credentials: "include", signal: AbortSignal.timeout(60_000) },
      )
      if (!res.ok) throw new Error("failed")
      const json = (await res.json()) as { runs: HistoryRow[]; total: number }
      setHistory((h) => ({
        ...h,
        [identifier]: { rows: json.runs ?? [], total: json.total ?? 0, offset, loading: false, error: false },
      }))
    } catch {
      notifyError(`Failed to load run history`)
      setHistory((h) => ({
        ...h,
        [identifier]: { ...(h[identifier] ?? { rows: [], total: 0, offset }), loading: false, error: true },
      }))
    }
  }, [notifyError])

  const toggle = useCallback((identifier: string) => {
    setExpanded((cur) => {
      const next = cur === identifier ? null : identifier
      if (next && !history[next]) void loadHistory(next, 0).catch((err: unknown) => { console.error("[mia]", err) })
      return next
    })
  }, [history, loadHistory])

  const toggleAdmin = useCallback(async (user: UserRow, next: boolean) => {
    if (!user.upn) return
    setAdminBusy(user.identifier)
    try {
      await api.setUserAdmin(user.identifier, next)
      await refreshSummary()
    } catch (err) {
      notifyError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdminBusy(null)
    }
  }, [refreshSummary, notifyError])

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

  const reloadExpandedHistorySilent = useCallback(() => {
    const exp = expandedRef.current
    if (!exp) return
    const offset = historyRef.current[exp]?.offset ?? 0
    void loadHistoryRef.current(exp, offset, { silent: true }).catch((err: unknown) => { console.error("[mia]", err) })
  }, [])

  useEffect(() => {
    void refreshSummary().catch((err: unknown) => { console.error("[mia]", err) })
  }, [refreshSummary])

  useEffect(() => {
    if (!connected) return
    void refreshSummary().catch((err: unknown) => { console.error("[mia]", err) })
  }, [connected, refreshSummary])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshSummary().catch((err: unknown) => { console.error("[mia]", err) })
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [refreshSummary])

  const onSseEvent = useCallback((event: { type: string; data: Record<string, unknown> }) => {
    if (isSummaryRefreshEvent(event.type)) {
      void refreshSummary().catch((err: unknown) => { console.error("[mia]", err) })
    }

    if (isActiveRunStepEvent(event.type)) {
      const runId = readSseRunId(event.data)
      if (runId) {
        setActiveRuns((prev) => prev.map((row) =>
          row.runId === runId ? { ...row, stepCount: row.stepCount + 1 } : row,
        ))
      }
    }

    if (isHistoryRefreshEvent(event.type)) {
      reloadExpandedHistorySilent()
    }
  }, [refreshSummary, reloadExpandedHistorySilent])

  useAdminSseEvents(onSseEvent)

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

  if (loading) {
    return (
      <div ref={rootRef} className="active-users-widget text-text-muted p-4">
        Loading…
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      className={[
        "active-users-widget relative h-full flex flex-col overflow-hidden min-w-0",
        useStack ? "active-users-widget--stack" : "active-users-widget--table",
        compact ? "active-users-widget--compact" : "",
        tiny ? "active-users-widget--tiny" : "",
      ].filter(Boolean).join(" ")}
    >
      {/* Stat strip */}
      {summary && (
        <div className="shrink-0 border-b border-border-subtle">
          <div className="au-stat-grid divide-x divide-border-subtle">
            <Stat label="Online"         value={String(summary.online)}        accent={summary.online > 0 ? "emerald" : undefined} />
            <Stat label="Users (7d)"     value={String(summary.users)} />
            <Stat label="Runs in flight" value={String(summary.runsInFlight)}  accent={summary.runsInFlight > 0 ? "blue" : undefined} />
            <Stat label="Runs (24h)"     value={String(summary.runs24h)} />
            <Stat label="Tokens (24h)"   value={formatCompact(summary.tokens24h)} />
          </div>
        </div>
      )}

      <ActiveUsersFilterBar
        filter={filter}
        setFilter={setFilter}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        failedOnly={failedOnly}
        setFailedOnly={setFailedOnly}
        lastSeenRange={lastSeenRange}
        setLastSeenRange={setLastSeenRange}
        userCount={filteredSorted.length}
        compact={compact}
        tiny={tiny}
        useStack={useStack}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
      />

      {/* Stack = reflow (no clip). Table = only when container is wide enough for all columns. */}
      <div className="flex-1 min-h-0 min-w-0 au-body-scroll">
        {useStack ? (
          <div className="au-user-list divide-y divide-border-subtle">
            {filteredSorted.map((u) => {
              const live = runsByIdentifier.get(u.identifier) ?? []
              const isOpen = expanded === u.identifier
              const hist = history[u.identifier]
              return (
                <Fragment key={u.identifier}>
                  <UserCardRow
                    user={u}
                    liveCount={live.length}
                    isOpen={isOpen}
                    onToggle={() => toggle(u.identifier)}
                  />
                  {isOpen && (
                    <div className="bg-overlay-1 border-b border-border-subtle min-w-0">
                      <UserDetail
                        user={u}
                        liveRuns={live}
                        history={hist}
                        stack
                        adminBusy={adminBusy === u.identifier}
                        onToggleAdmin={(next) => void toggleAdmin(u, next).catch((err: unknown) => { console.error("[mia]", err) })}
                        onPageChange={(offset) => void loadHistory(u.identifier, offset).catch((err: unknown) => { console.error("[mia]", err) })}
                        onCollapse={() => toggle(u.identifier)}
                        onRunClick={(runId, preview) => setRunModal({ runId, preview })}
                      />
                    </div>
                  )}
                </Fragment>
              )
            })}
            {filteredSorted.length === 0 && (
              <EmptyState
                icon={WIDGET_ICONS["active-users"]}
                message={filter ? "No users match filter." : "No sessions yet."}
                className="py-8"
              />
            )}
          </div>
        ) : (
          <table className="au-users-table w-full border-collapse">
            <thead className="sticky top-0 z-20 bg-surface">
              <tr className="text-left text-xs uppercase tracking-wider text-text-muted border-b border-border-subtle">
                <SortTh k="status" current={sortKey} dir={sortDir} onClick={onSort} className="w-8" label="" />
                <SortTh k="name" current={sortKey} dir={sortDir} onClick={onSort} className="au-th-name" label="Name" />
                <SortTh k="upn" current={sortKey} dir={sortDir} onClick={onSort} className="au-th-upn" label="UPN / Session" />
                <SortTh k="sessions" current={sortKey} dir={sortDir} onClick={onSort} className="text-right" label="Sessions" />
                <SortTh k="totalRuns" current={sortKey} dir={sortDir} onClick={onSort} className="text-right" label="Total Runs" />
                <SortTh k="runs24h" current={sortKey} dir={sortDir} onClick={onSort} className="text-right" label="Runs 24h" />
                <SortTh k="failed24h" current={sortKey} dir={sortDir} onClick={onSort} className="text-right" label="Failed 24h" />
                <SortTh k="tokens24h" current={sortKey} dir={sortDir} onClick={onSort} className="text-right" label="Tokens 24h" />
                <SortTh k="llmCalls24h" current={sortKey} dir={sortDir} onClick={onSort} className="text-right" label="LLM Calls" />
                <SortTh k="lastModel" current={sortKey} dir={sortDir} onClick={onSort} label="Model" />
                <SortTh k="firstSeen" current={sortKey} dir={sortDir} onClick={onSort} label="First Seen" />
                <SortTh k="lastSeen" current={sortKey} dir={sortDir} onClick={onSort} label="Last Seen" />
                <th className="py-2 px-2 text-xs w-8 bg-surface" aria-hidden />
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
                      <td className="py-2 px-3 w-8">
                        <UserStatusDot user={u} liveCount={live.length} />
                      </td>
                      <td className="py-2 px-3 au-td-name">
                        <UserNameCell user={u} />
                      </td>
                      <td className="py-2 px-3 au-td-upn">
                        <UserUpnCell user={u} />
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-text-muted">{u.sessionCount}</td>
                      <td className="py-2 px-3 text-right tabular-nums text-text">
                        {u.totalRuns > 0 ? u.totalRuns : <span className="text-text-muted/50">0</span>}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-text">
                        {u.runs24h > 0 ? u.runs24h : <span className="text-text-muted/50">0</span>}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums">
                        {u.runsFailed24h > 0
                          ? <span className="text-error">{u.runsFailed24h}</span>
                          : <span className="text-text-muted/50">0</span>}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-text-muted">
                        {u.totalTokens24h > 0 ? formatCompact(u.totalTokens24h) : <span className="text-text-muted/50">0</span>}
                      </td>
                      <td className="py-2 px-3 text-right tabular-nums text-text-muted">
                        {u.totalLlmCalls24h > 0 ? u.totalLlmCalls24h : <span className="text-text-muted/50">0</span>}
                      </td>
                      <td className="py-2 px-3 text-text-muted whitespace-nowrap">
                        {u.lastModel ?? <span className="text-text-muted/50">—</span>}
                      </td>
                      <td className="py-2 px-3 text-text-muted whitespace-nowrap" title={u.firstSeenAt}>
                        {formatRelative(u.firstSeenAt)}
                      </td>
                      <td className="py-2 px-3 text-text-muted whitespace-nowrap" title={u.lastSeenAt}>
                        {formatRelative(u.lastSeenAt)}
                      </td>
                      <td className="py-2 px-2 text-text-muted w-8">{isOpen ? "▾" : "▸"}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-overlay-1">
                        <td colSpan={AU_TABLE_COL_SPAN} className="w-0 min-w-0 p-0 align-top">
                          <UserDetail
                            user={u}
                            liveRuns={live}
                            history={hist}
                            stack={false}
                            adminBusy={adminBusy === u.identifier}
                            onToggleAdmin={(next) => void toggleAdmin(u, next).catch((err: unknown) => { console.error("[mia]", err) })}
                            onPageChange={(offset) => void loadHistory(u.identifier, offset).catch((err: unknown) => { console.error("[mia]", err) })}
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
                <tr>
                  <td colSpan={AU_TABLE_COL_SPAN}>
                    <EmptyState
                      icon={WIDGET_ICONS["active-users"]}
                      message={filter ? "No users match filter." : "No sessions yet."}
                      className="py-8"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {runModal && (
        <ActiveUsersRunModal
          runId={runModal.runId}
          preview={runModal.preview}
          onClose={() => setRunModal(null)}
        />
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}

// ── Filter bar ─────────────────────────────────────────────────

const STATUS_LABELS: Record<"all" | "online" | "running" | "offline", string> = {
  all: "all",
  online: "online",
  running: "running",
  offline: "offline",
}

const RANGE_LABELS: Record<"all" | "1h" | "24h" | "7d", string> = {
  all: "any time",
  "1h": "last 1h",
  "24h": "last 24h",
  "7d": "last 7d",
}

function ActiveUsersFilterBar({
  filter,
  setFilter,
  statusFilter,
  setStatusFilter,
  failedOnly,
  setFailedOnly,
  lastSeenRange,
  setLastSeenRange,
  userCount,
  compact,
  tiny,
  useStack,
  sortKey,
  sortDir,
  onSort,
}: {
  filter: string
  setFilter: (value: string) => void
  statusFilter: "all" | "online" | "running" | "offline"
  setStatusFilter: (value: "all" | "online" | "running" | "offline") => void
  failedOnly: boolean
  setFailedOnly: (value: boolean | ((prev: boolean) => boolean)) => void
  lastSeenRange: "all" | "1h" | "24h" | "7d"
  setLastSeenRange: (value: "all" | "1h" | "24h" | "7d") => void
  userCount: number
  compact: boolean
  tiny: boolean
  useStack: boolean
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey) => void
}) {
  const statusLabel = statusFilter === "all" ? "status" : STATUS_LABELS[statusFilter]
  const rangeLabel = tiny
    ? (lastSeenRange === "all" ? "time" : lastSeenRange)
    : (lastSeenRange === "all" ? "any time" : RANGE_LABELS[lastSeenRange])
  const sortLabel = `${SORT_LABELS[sortKey]} ${sortDir === "asc" ? "↑" : "↓"}`

  return (
    <div className="au-filter-bar shrink-0 border-b border-border-subtle px-3 py-2">
      <input
        className="au-filter-search bg-transparent text-text placeholder:text-text-muted/50 outline-none border border-border-subtle rounded-md px-2.5 py-1.5 focus:border-accent/50"
        placeholder="Filter by name, UPN, IP, model…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        spellCheck={false}
      />

      <div className="au-filter-controls">
        {!compact ? (
          <>
            <div className="au-filter-inline flex items-center gap-0.5 shrink-0">
              {(["all", "online", "running", "offline"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`px-2 py-1 rounded-md transition-colors ${
                    statusFilter === s
                      ? "bg-accent/15 text-accent"
                      : "text-text-muted hover:text-text hover:bg-overlay-2"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setFailedOnly((v) => !v)}
              className={`px-2 py-1 rounded-md transition-colors shrink-0 ${
                failedOnly ? "bg-error-soft text-error" : "text-text-muted hover:text-text hover:bg-overlay-2"
              }`}
            >
              failed only
            </button>
            <div className="au-filter-inline flex items-center gap-0.5 shrink-0">
              {(["all", "1h", "24h", "7d"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setLastSeenRange(r)}
                  className={`px-2 py-1 rounded-md transition-colors ${
                    lastSeenRange === r
                      ? "bg-accent/15 text-accent"
                      : "text-text-muted hover:text-text hover:bg-overlay-2"
                  }`}
                >
                  {RANGE_LABELS[r]}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <WidgetToolbarFilterMenu
              label={statusLabel}
              active={statusFilter !== "all"}
              ariaLabel="Filter by status"
            >
              {(["all", "online", "running", "offline"] as const).map((s) => (
                <WidgetToolbarFilterMenuItem
                  key={s}
                  label={STATUS_LABELS[s]}
                  active={statusFilter === s}
                  onClick={() => setStatusFilter(s)}
                />
              ))}
            </WidgetToolbarFilterMenu>
            <button
              type="button"
              onClick={() => setFailedOnly((v) => !v)}
              className={`px-2 py-1 rounded-md text-sm transition-colors shrink-0 ${
                failedOnly ? "bg-error-soft text-error" : "text-text-muted hover:text-text hover:bg-overlay-2"
              }`}
            >
              {tiny ? "failed" : "failed only"}
            </button>
            <WidgetToolbarFilterMenu
              label={rangeLabel}
              active={lastSeenRange !== "all"}
              ariaLabel="Filter by last seen"
            >
              {(["all", "1h", "24h", "7d"] as const).map((r) => (
                <WidgetToolbarFilterMenuItem
                  key={r}
                  label={RANGE_LABELS[r]}
                  active={lastSeenRange === r}
                  onClick={() => setLastSeenRange(r)}
                />
              ))}
            </WidgetToolbarFilterMenu>
          </>
        )}
        {useStack && (
          <WidgetToolbarFilterMenu
            label={sortLabel}
            active
            ariaLabel="Sort users"
          >
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <WidgetToolbarFilterMenuItem
                key={k}
                label={SORT_LABELS[k]}
                active={sortKey === k}
                onClick={() => onSort(k)}
              />
            ))}
          </WidgetToolbarFilterMenu>
        )}
      </div>

      <span className="au-filter-count au-label tabular-nums shrink-0">
        {userCount} {userCount === 1 ? "user" : "users"}
      </span>
    </div>
  )
}

// ── User row cells (shared by list + table layouts) ─────────────

function UserStatusDot({ user, liveCount }: { user: UserRow; liveCount: number }) {
  if (liveCount > 0) {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-info animate-pulse"
        title={`${liveCount} running`}
      />
    )
  }
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${user.online ? "bg-success" : "bg-text-muted/40"}`}
      title={user.online ? "online" : "offline"}
    />
  )
}

function UserNameCell({ user }: { user: UserRow }) {
  return (
    <div className="min-w-0">
      <div className="text-text truncate">
        {user.displayName ?? <span className="text-text-muted/60">—</span>}
        {user.isAdmin ? (
          <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 au-label font-semibold text-accent">
            admin
          </span>
        ) : null}
        {user.runsFailed24h > 0 && (
          <span className="ml-2 text-error">{user.runsFailed24h} fail</span>
        )}
      </div>
    </div>
  )
}

function UserUpnCell({ user }: { user: UserRow }) {
  return (
    <div
      className="font-mono text-text-muted truncate select-text cursor-text"
      onClick={(e) => e.stopPropagation()}
    >
      {user.upn ?? (() => {
        const isName = user.identifier.startsWith("name:")
        const short = isName ? user.identifier.slice(5) : user.identifier.slice(4, 20)
        return (
          <span title={isName ? user.identifier.slice(5) : user.identifier.slice(4)}>
            anon · {short}
          </span>
        )
      })()}
      <CopyBtn value={user.upn ?? user.identifier} label="UPN" />
    </div>
  )
}

function CardMetric({ label, value, danger }: { label: string; value: ReactNode; danger?: boolean }) {
  return (
    <div className="au-card-metric min-w-0">
      <div className="au-label">{label}</div>
      <div className={`tabular-nums text-sm truncate ${danger ? "text-error" : "text-text"}`}>{value}</div>
    </div>
  )
}

function UserCardRow({
  user,
  liveCount,
  isOpen,
  onToggle,
}: {
  user: UserRow
  liveCount: number
  isOpen: boolean
  onToggle: () => void
}) {
  const upnLabel = user.upn ?? (() => {
    const isName = user.identifier.startsWith("name:")
    return isName ? user.identifier.slice(5) : `anon · ${user.identifier.slice(4, 12)}`
  })()

  return (
    <button
      type="button"
      className={`au-user-card w-full text-left px-3 py-3 hover:bg-overlay-2 transition-colors ${isOpen ? "bg-overlay-2" : ""}`}
      onClick={onToggle}
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <span className="shrink-0 pt-1.5">
          <UserStatusDot user={user} liveCount={liveCount} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-text truncate font-medium">
              {user.displayName ?? <span className="text-text-muted/60">—</span>}
            </span>
            {user.isAdmin ? (
              <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 au-label font-semibold text-accent">
                admin
              </span>
            ) : null}
          </span>
          <span
            className="mt-0.5 flex items-center gap-1 font-mono text-xs text-text-muted truncate"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="truncate">{upnLabel}</span>
            <CopyBtn value={user.upn ?? user.identifier} label="UPN" />
          </span>
        </span>
        <span className="shrink-0 pt-1 text-text-muted">{isOpen ? "▾" : "▸"}</span>
      </div>

      <div className="au-card-metrics mt-3">
        <CardMetric label="Sessions" value={user.sessionCount} />
        <CardMetric label="Total Runs" value={user.totalRuns} />
        <CardMetric label="Runs 24h" value={user.runs24h} />
        <CardMetric label="Failed 24h" value={user.runsFailed24h} danger={user.runsFailed24h > 0} />
        <CardMetric label="Tokens 24h" value={user.totalTokens24h > 0 ? formatCompact(user.totalTokens24h) : "0"} />
        <CardMetric label="LLM Calls" value={user.totalLlmCalls24h} />
        <CardMetric label="Model" value={user.lastModel ?? "—"} />
        <CardMetric label="First Seen" value={formatRelative(user.firstSeenAt)} />
        <CardMetric label="Last Seen" value={formatRelative(user.lastSeenAt)} />
      </div>
    </button>
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
      className={`py-2 px-3 text-xs font-semibold cursor-pointer select-none hover:text-text transition-colors bg-surface whitespace-nowrap ${active ? "text-text" : ""} ${className ?? ""}`}
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

/** Run-history table needs ~this many CSS px; below → stacked cards. */
const AU_RUN_TABLE_MIN_WIDTH_PX = 720

function UserDetail({ user, liveRuns, history, stack, adminBusy, onToggleAdmin, onPageChange, onCollapse, onRunClick }: {
  user: UserRow; liveRuns: ActiveRunRow[]
  history: HistoryState | undefined
  stack: boolean
  adminBusy: boolean
  onToggleAdmin: (next: boolean) => void
  onPageChange: (offset: number) => void
  onCollapse: () => void
  onRunClick: (runId: string, preview?: RunPreview) => void
}) {
  const detailRef = useRef<HTMLDivElement>(null)
  const { width: detailWidth } = useContainerSize(detailRef)
  // Parent `stack` covers the user list; run history follows *this* panel —
  // a wide users table can still leave a narrow detail column / window.
  const stackRuns = stack || detailWidth === 0 || detailWidth < AU_RUN_TABLE_MIN_WIDTH_PX

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
    <div ref={detailRef} className="au-detail-panel min-w-0 border-t border-border-subtle bg-overlay-1">

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
        <div className="au-detail-meta-grid">
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
        {history && !history.loading && history.rows.length === 0 && !history.error && (
          <EmptyState
            icon={WIDGET_ICONS["run-history"]}
            message="No runs yet."
            className="py-6"
          />
        )}

        {/* Run list — stack cards when *this* panel is narrow, table when wide */}
        {history && history.rows.length > 0 && (
          stackRuns ? (
            <div className="au-run-stack divide-y divide-border-subtle">
              {displayRows.length === 0 ? (
                <div className="px-4 py-5 text-center text-text-muted/40">No runs match filter.</div>
              ) : displayRows.map((h) => (
                <button
                  key={h.runId}
                  type="button"
                  className="au-run-card w-full text-left px-4 py-3 hover:bg-overlay-2 transition-colors min-w-0"
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
                  <div className="flex items-start gap-2 min-w-0">
                    <span className="shrink-0 pt-1"><StatusDot status={h.status} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
                        <span
                          className="font-mono select-text"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {h.runId.slice(0, 8)}
                          <CopyBtn value={h.runId} label="run ID" />
                        </span>
                        <span title={h.createdAt}>{formatRelative(h.createdAt)}</span>
                        <span className="tabular-nums">{formatDuration(h.durationMs)}</span>
                        <span className="tabular-nums">{h.stepCount} steps</span>
                        {h.totalTokens != null && (
                          <span className="tabular-nums">{formatCompact(h.totalTokens)} tok</span>
                        )}
                        {h.model && <span className="truncate max-w-[10rem]">{h.model}</span>}
                      </span>
                      <span className="mt-1 block text-sm text-text break-words" title={h.error ? `${h.goal}\n\nError: ${h.error}` : h.goal}>
                        {h.error && <span className="text-error/90 mr-1.5" title={h.error}>⚠</span>}
                        {h.goal}
                      </span>
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="au-run-table-wrap min-w-0">
              <table className="w-full border-collapse">
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
          )
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
        }).catch((err: unknown) => { console.error("[mia]", err) })
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
