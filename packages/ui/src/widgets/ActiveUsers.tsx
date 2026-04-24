/**
 * ActiveUsers — admin-only live + historical view of who's using agent001.
 *
 * Data sources (polled every 5s):
 *   GET /api/admin/users             — aggregated per-user stats (24h window)
 *   GET /api/admin/active-runs       — currently executing runs (for live ●)
 *   GET /api/admin/users/:id/runs    — drill-down history (lazy, on row click)
 *
 * Layout:
 *   ┌ Summary chips (online / users / runs in flight / runs 24h / tokens 24h)
 *   ├ Per-user table (one row per UPN, or per anonymous sid)
 *   └ Expanded row: per-user run history (status, started, duration, tokens, model, goal)
 *
 * Identity grouping: server keys by UPN when set; anonymous visitors are
 * keyed by `sid:<sid>` so each browser session shows up as a distinct row.
 */

import type { ReactNode } from "react"
import { Fragment, useCallback, useEffect, useMemo, useState } from "react"

interface UserRow {
  identifier: string
  upn: string | null
  displayName: string | null
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
  users: number
  online: number
  runsInFlight: number
  runs24h: number
  tokens24h: number
}

interface ActiveRunRow {
  runId: string
  goal: string
  status: string
  sessionId: string | null
  upn: string | null
  displayName: string | null
  createdAt: string
  stepCount: number
}

interface HistoryRow {
  runId: string
  goal: string
  status: string
  stepCount: number
  createdAt: string
  completedAt: string | null
  durationMs: number | null
  totalTokens: number | null
  llmCalls: number | null
  model: string | null
  error: string | null
}

const REFRESH_MS = 5000

export function ActiveUsers(): ReactNode {
  const [users, setUsers] = useState<UserRow[]>([])
  const [summary, setSummary] = useState<UserSummary | null>(null)
  const [activeRuns, setActiveRuns] = useState<ActiveRunRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [history, setHistory] = useState<Record<string, HistoryRow[] | "loading" | "error">>({})

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

  useEffect(() => {
    let alive = true
    const tick = () => { if (alive) void refresh() }
    tick()
    const interval = setInterval(tick, REFRESH_MS)
    return () => { alive = false; clearInterval(interval) }
  }, [refresh])

  const loadHistory = useCallback(async (identifier: string) => {
    setHistory((h) => ({ ...h, [identifier]: "loading" }))
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(identifier)}/runs?limit=25`, { credentials: "include" })
      if (!res.ok) { setHistory((h) => ({ ...h, [identifier]: "error" })); return }
      const json = (await res.json()) as { runs: HistoryRow[] }
      setHistory((h) => ({ ...h, [identifier]: json.runs ?? [] }))
    } catch {
      setHistory((h) => ({ ...h, [identifier]: "error" }))
    }
  }, [])

  const toggle = useCallback((identifier: string) => {
    setExpanded((cur) => {
      const next = cur === identifier ? null : identifier
      if (next && !history[next]) void loadHistory(next)
      return next
    })
  }, [history, loadHistory])

  // Live in-flight runs grouped by user identity (UPN or sid:<sid>).
  const runsByIdentifier = useMemo(() => {
    const m = new Map<string, ActiveRunRow[]>()
    for (const r of activeRuns) {
      const key = r.upn ?? (r.sessionId ? `sid:${r.sessionId}` : null)
      if (!key) continue
      const list = m.get(key) ?? []
      list.push(r)
      m.set(key, list)
    }
    return m
  }, [activeRuns])

  if (loading) return <div className="text-sm text-text-muted">Loading…</div>
  if (error)   return <div className="text-sm text-red-400">{error}</div>

  return (
    <div className="h-full overflow-auto space-y-4">
      {/* Stat strip — its own card, visually distinct from the table */}
      {summary && (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.025] overflow-hidden">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-white/[0.06]">
            <Stat label="Online"         value={String(summary.online)}        accent={summary.online > 0 ? "emerald" : undefined} />
            <Stat label="Users (7d)"     value={String(summary.users)} />
            <Stat label="Runs in flight" value={String(summary.runsInFlight)}  accent={summary.runsInFlight > 0 ? "blue" : undefined} />
            <Stat label="Runs (24h)"     value={String(summary.runs24h)} />
            <Stat label="Tokens (24h)"   value={formatCompact(summary.tokens24h)} />
          </div>
        </div>
      )}

      {/* Per-user table — separate card */}
      <div className="rounded-lg border border-white/[0.06] bg-white/[0.015] overflow-hidden">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-text-muted text-left border-b border-white/[0.06] text-xs uppercase tracking-wider bg-white/[0.02]">
              <th className="py-2 px-3 w-6"></th>
              <th className="py-2 px-3 font-semibold">Name</th>
              <th className="py-2 px-3 font-semibold">UPN / Session</th>
              <th className="py-2 px-3 font-semibold">Now</th>
              <th className="py-2 px-3 font-semibold text-right">Runs 24h</th>
              <th className="py-2 px-3 font-semibold text-right">Tokens 24h</th>
              <th className="py-2 px-3 font-semibold">Last model</th>
              <th className="py-2 px-3 font-semibold">Last seen</th>
              <th className="py-2 px-3 w-6"></th>
            </tr>
          </thead>
        <tbody>
          {users.map((u) => {
            const live = runsByIdentifier.get(u.identifier) ?? []
            const isOpen = expanded === u.identifier
            const hist = history[u.identifier]
            return (
              <Fragment key={u.identifier}>
                <tr
                  className={`border-b border-white/[0.03] cursor-pointer hover:bg-white/[0.03] ${isOpen ? "bg-white/[0.04]" : ""}`}
                  onClick={() => toggle(u.identifier)}
                >
                  <td className="py-2 px-3">
                    <span
                      className={`inline-block w-2 h-2 rounded-full ${u.online ? "bg-emerald-400" : "bg-text-muted/40"}`}
                      title={u.online ? "online (last seen <60s ago)" : "offline"}
                    />
                  </td>
                  <td className="py-2 px-3 text-text">
                    {u.displayName ?? <span className="text-text-muted/60">—</span>}
                    {u.runsFailed24h > 0 && (
                      <span className="ml-2 text-xs text-red-400" title={`${u.runsFailed24h} failed runs in last 24h`}>
                        {u.runsFailed24h} fail
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 font-mono text-xs text-text-muted">
                    {u.upn ?? <span title={u.identifier.slice(4)}>anon · {u.identifier.slice(4, 12)}</span>}
                    {u.sessionCount > 1 && <span className="ml-1 text-text-muted/60">×{u.sessionCount}</span>}
                  </td>
                  <td className="py-2 px-3 text-text-muted">
                    {live.length === 0 ? (
                      <span className="text-text-muted/50">idle</span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        <span className="text-emerald-400">{live.length} running</span>
                      </span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-text">
                    {u.runs24h > 0 ? u.runs24h : <span className="text-text-muted/50">0</span>}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-text-muted">
                    {u.totalTokens24h > 0 ? formatCompact(u.totalTokens24h) : <span className="text-text-muted/50">0</span>}
                  </td>
                  <td className="py-2 px-3 text-text-muted">
                    {u.lastModel ?? <span className="text-text-muted/50">—</span>}
                  </td>
                  <td className="py-2 px-3 text-text-muted" title={u.lastSeenAt}>
                    {formatRelative(u.lastSeenAt)}
                  </td>
                  <td className="py-2 px-3 text-text-muted text-xs">{isOpen ? "▾" : "▸"}</td>
                </tr>
                {isOpen && (
                  <tr className="bg-white/[0.02]">
                    <td colSpan={9} className="px-3 pb-3 pt-1">
                      <UserDetail user={u} liveRuns={live} history={hist} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          {users.length === 0 && (
            <tr><td colSpan={9} className="py-6 text-center text-text-muted">No sessions yet.</td></tr>
          )}
        </tbody>
      </table>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────

/**
 * Stat — single KPI in the divided strip above the table. Big value,
 * tiny uppercase label below. Optional accent dot for live signals.
 * Visually flat (no border/background) so it reads as data, not a button.
 */
function Stat({ label, value, accent }: { label: string; value: string; accent?: "emerald" | "blue" }) {
  const dot =
    accent === "emerald" ? "bg-emerald-400"
    : accent === "blue"  ? "bg-blue-400"
    : null
  const valueColor =
    accent === "emerald" ? "text-emerald-300"
    : accent === "blue"  ? "text-blue-300"
    : "text-text"
  return (
    <div className="px-4 py-3 flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        {dot && <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot} ${accent === "emerald" ? "animate-pulse" : ""}`} />}
        <span className={`text-lg font-semibold tabular-nums leading-none ${valueColor}`}>{value}</span>
      </div>
      <div className="text-[11px] text-text-muted uppercase tracking-wider">{label}</div>
    </div>
  )
}

function UserDetail({
  user, liveRuns, history,
}: {
  user: UserRow
  liveRuns: ActiveRunRow[]
  history: HistoryRow[] | "loading" | "error" | undefined
}) {
  return (
    <div className="border-l-2 border-blue-500/40 pl-3 py-2 space-y-3">
      {/* Identity & session metadata */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs">
        <Field label="First seen"     value={formatAbsolute(user.firstSeenAt)} />
        <Field label="Last seen"      value={formatAbsolute(user.lastSeenAt)} />
        <Field label="Sessions (7d)"  value={String(user.sessionCount)} />
        <Field label="Total runs"     value={String(user.totalRuns)} />
        <Field label="Last IP"        value={user.lastIp ?? "—"} mono />
        <Field label="Last model"     value={user.lastModel ?? "—"} mono />
        <Field label="LLM calls 24h"  value={String(user.totalLlmCalls24h)} />
        <Field label="Last run"       value={user.lastRunAt ? formatRelative(user.lastRunAt) : "—"} />
      </div>
      {user.lastUserAgent && (
        <div className="text-[11px] text-text-muted/70 truncate" title={user.lastUserAgent}>
          UA: {user.lastUserAgent}
        </div>
      )}

      {/* Live in-flight runs */}
      {liveRuns.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-emerald-400 uppercase tracking-wider mb-1.5">Now running</div>
          <ul className="space-y-1">
            {liveRuns.map((r) => (
              <li key={r.runId} className="text-sm flex gap-2">
                <span className="font-mono text-xs text-text-muted">{r.runId.slice(0, 8)}</span>
                <span className="text-text-muted">step {r.stepCount}</span>
                <span className="truncate flex-1 text-text" title={r.goal}>{r.goal}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* History */}
      <div>
        <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-1.5">Recent runs</div>
        {history === "loading" && <div className="text-xs text-text-muted">Loading history…</div>}
        {history === "error"   && <div className="text-xs text-red-400">Failed to load history.</div>}
        {Array.isArray(history) && history.length === 0 && (
          <div className="text-xs text-text-muted/70">No runs yet.</div>
        )}
        {Array.isArray(history) && history.length > 0 && (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-text-muted/80 text-left border-b border-white/[0.04]">
                <th className="py-1.5 px-2 w-6"></th>
                <th className="py-1.5 px-2 font-semibold">Run</th>
                <th className="py-1.5 px-2 font-semibold">Started</th>
                <th className="py-1.5 px-2 font-semibold text-right">Duration</th>
                <th className="py-1.5 px-2 font-semibold text-right">Steps</th>
                <th className="py-1.5 px-2 font-semibold text-right">Tokens</th>
                <th className="py-1.5 px-2 font-semibold">Model</th>
                <th className="py-1.5 px-2 font-semibold">Goal</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.runId} className="border-b border-white/[0.02]">
                  <td className="py-1 px-2"><StatusDot status={h.status} /></td>
                  <td className="py-1 px-2 font-mono text-text-muted">{h.runId.slice(0, 8)}</td>
                  <td className="py-1 px-2 text-text-muted" title={h.createdAt}>{formatRelative(h.createdAt)}</td>
                  <td className="py-1 px-2 text-right tabular-nums text-text-muted">{formatDuration(h.durationMs)}</td>
                  <td className="py-1 px-2 text-right tabular-nums text-text-muted">{h.stepCount}</td>
                  <td className="py-1 px-2 text-right tabular-nums text-text-muted">{h.totalTokens != null ? formatCompact(h.totalTokens) : "—"}</td>
                  <td className="py-1 px-2 text-text-muted">{h.model ?? "—"}</td>
                  <td className="py-1 px-2 truncate max-w-[260px] text-text" title={h.error ? `${h.goal}\n\nError: ${h.error}` : h.goal}>
                    {h.goal}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <span className="text-text-muted/70">{label}:</span>
      <span className={`text-text ${mono ? "font-mono text-[11px]" : ""}`}>{value}</span>
    </div>
  )
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "succeeded" || status === "completed" ? "bg-emerald-400"
    : status === "running" || status === "pending" || status === "planning" ? "bg-blue-400 animate-pulse"
    : status === "error" || status === "failed" || status === "timeout" ? "bg-red-400"
    : "bg-text-muted/40"
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={status} />
}

// ── Formatters ──────────────────────────────────────────────────

/** SQLite stores datetimes as naive UTC strings ("YYYY-MM-DD HH:MM:SS"). */
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
