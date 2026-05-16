/**
 * SyncAdmin — F1.9 admin surface.
 *
 * Three sub-panels (tabbed):
 *   • Schedules        — cron-driven proposer runs per env-pair
 *   • Approval policies — none/single/dual per risk tier with TTL
 *   • Notification routes — email/teams/slack per event type
 *
 * Every panel is admin-only; non-admins see read-only listings.
 */

import {
  AlertCircle, CheckCircle2, Hash, Loader2, Mail, MessageSquare, Plus, RefreshCw,
  ShieldCheck, Trash2, X,
} from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../api"
import { useMe } from "../hooks/useMe"
import { timeAgo } from "../util"

type Tab = "schedules" | "policies" | "routes"

export function SyncAdmin(): JSX.Element {
  const [tab, setTab] = useState<Tab>("schedules")
  return (
    <div className="h-full flex flex-col text-sm">
      <div className="flex items-center gap-1 p-2 border-b border-slate-800 text-xs">
        {(["schedules", "policies", "routes"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-1 rounded ${tab === t ? "bg-slate-800" : "hover:bg-slate-800/60"}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {tab === "schedules" && <Schedules/>}
        {tab === "policies"  && <Policies/>}
        {tab === "routes"    && <Routes/>}
      </div>
    </div>
  )
}

// ── Schedules ──────────────────────────────────────────────────

interface Schedule { tenant_id: string; source: string; target: string; cron: string; enabled: number; next_run_at: string | null; last_run_at: string | null }

function Schedules(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Schedule[]>([])
  const [busy, setBusy]   = useState(false)
  const [err,  setErr]    = useState<string | null>(null)
  const [ok,   setOk]     = useState<string | null>(null)
  const [draft, setDraft] = useState({ source: "", target: "", cron: "0 */6 * * *", enabled: true })

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try { setItems((await api.listProposerSchedules()) as unknown as Schedule[]) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [])

  async function save(): Promise<void> {
    try {
      await api.upsertProposerSchedule(draft)
      setOk("saved"); setTimeout(() => setOk(null), 1500)
      setDraft({ source: "", target: "", cron: "0 */6 * * *", enabled: true })
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function remove(s: Schedule): Promise<void> {
    if (!confirm(`Delete schedule for ${s.source} → ${s.target}?`)) return
    try { await api.deleteProposerSchedule(s.tenant_id, s.source, s.target); await refresh() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <Panel title="Schedules" busy={busy} onRefresh={refresh} err={err} ok={ok} clearErr={() => setErr(null)}>
      {isAdmin && (
        <div className="grid grid-cols-[1fr_1fr_1.5fr_auto_auto] gap-2 items-center text-xs mb-2">
          <input className="input" placeholder="source" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })}/>
          <input className="input" placeholder="target" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}/>
          <input className="input" placeholder="cron (5-field, UTC)" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })}/>
          <label className="flex items-center gap-1"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}/> enabled</label>
          <button className="btn-primary flex items-center gap-1" onClick={save}><Plus size={12}/> upsert</button>
        </div>
      )}
      <table className="w-full text-xs">
        <thead><tr className="text-slate-500 text-left">
          <th className="py-1 px-2">source</th><th>target</th><th>cron</th><th>enabled</th><th>next</th><th>last</th><th></th>
        </tr></thead>
        <tbody>
          {items.map((s) => (
            <tr key={`${s.tenant_id}|${s.source}|${s.target}`} className="border-t border-slate-800">
              <td className="py-1 px-2">{s.source}</td><td>{s.target}</td>
              <td className="font-mono">{s.cron}</td>
              <td>{s.enabled ? "yes" : "no"}</td>
              <td title={s.next_run_at ?? ""}>{s.next_run_at ? timeAgo(s.next_run_at) : "—"}</td>
              <td title={s.last_run_at ?? ""}>{s.last_run_at ? timeAgo(s.last_run_at) : "—"}</td>
              <td>{isAdmin && <button onClick={() => remove(s)} className="text-red-300 hover:text-red-200"><Trash2 size={12}/></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

// ── Approval Policies ─────────────────────────────────────────

interface Policy { tenant_id: string; risk_tier: string; kind: "none"|"single"|"dual"; ttl_ms: number; allow_self_requester: number; bypass_role: string | null }

function Policies(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Policy[]>([])
  const [busy, setBusy]   = useState(false)
  const [err,  setErr]    = useState<string | null>(null)
  const [ok,   setOk]     = useState<string | null>(null)
  const [draft, setDraft] = useState<{ riskTier: string; kind: "none"|"single"|"dual"; ttlMs: number; allowSelfRequester: boolean; bypassRole: string }>({
    riskTier: "medium", kind: "single", ttlMs: 86_400_000, allowSelfRequester: false, bypassRole: "admin",
  })

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try { setItems((await api.listApprovalPolicies()) as unknown as Policy[]) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [])

  async function save(): Promise<void> {
    try {
      await api.upsertApprovalPolicy(draft)
      setOk("saved"); setTimeout(() => setOk(null), 1500)
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <Panel title="Approval policies" busy={busy} onRefresh={refresh} err={err} ok={ok} clearErr={() => setErr(null)}>
      {isAdmin && (
        <div className="grid grid-cols-[120px_120px_140px_140px_120px_auto] gap-2 items-center text-xs mb-2">
          <input className="input" value={draft.riskTier} onChange={(e) => setDraft({ ...draft, riskTier: e.target.value })} placeholder="risk tier"/>
          <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as "none"|"single"|"dual" })}>
            <option value="none">none</option><option value="single">single</option><option value="dual">dual</option>
          </select>
          <input className="input" type="number" value={draft.ttlMs} onChange={(e) => setDraft({ ...draft, ttlMs: Number(e.target.value) })} placeholder="TTL ms"/>
          <input className="input" value={draft.bypassRole} onChange={(e) => setDraft({ ...draft, bypassRole: e.target.value })} placeholder="bypass role"/>
          <label className="flex items-center gap-1"><input type="checkbox" checked={draft.allowSelfRequester} onChange={(e) => setDraft({ ...draft, allowSelfRequester: e.target.checked })}/> self?</label>
          <button className="btn-primary flex items-center gap-1" onClick={save}><ShieldCheck size={12}/> upsert</button>
        </div>
      )}
      <table className="w-full text-xs">
        <thead><tr className="text-slate-500 text-left"><th className="py-1 px-2">risk tier</th><th>kind</th><th>TTL (ms)</th><th>self</th><th>bypass role</th></tr></thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.risk_tier} className="border-t border-slate-800">
              <td className="py-1 px-2">{p.risk_tier}</td><td>{p.kind}</td><td>{p.ttl_ms}</td>
              <td>{p.allow_self_requester ? "yes" : "no"}</td><td>{p.bypass_role ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

// ── Notification routes ───────────────────────────────────────

interface Route { id: string; tenant_id: string; event_type: string; filter_json: string; channel: "email"|"teams"|"slack"; target: string; enabled: number; updated_at: string; updated_by: string }

function Routes(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Route[]>([])
  const [busy, setBusy]   = useState(false)
  const [err,  setErr]    = useState<string | null>(null)
  const [ok,   setOk]     = useState<string | null>(null)
  const [draft, setDraft] = useState({
    eventType: "sync.approval.requested", channel: "email" as "email"|"teams"|"slack",
    target: "", filter: "{}", enabled: true,
  })

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try { setItems((await api.listNotificationRoutes()) as unknown as Route[]) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  useEffect(() => { void refresh() }, [])

  async function save(): Promise<void> {
    try {
      const filter = JSON.parse(draft.filter)
      await api.upsertNotificationRoute({ eventType: draft.eventType, channel: draft.channel, target: draft.target, filter, enabled: draft.enabled })
      setOk("saved"); setTimeout(() => setOk(null), 1500)
      setDraft({ ...draft, target: "" })
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function remove(r: Route): Promise<void> {
    if (!confirm(`Delete route for ${r.event_type} → ${r.channel}?`)) return
    try { await api.deleteNotificationRoute(r.id); await refresh() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <Panel title="Notification routes" busy={busy} onRefresh={refresh} err={err} ok={ok} clearErr={() => setErr(null)}>
      {isAdmin && (
        <div className="grid grid-cols-[1.5fr_120px_2fr_1.5fr_auto_auto] gap-2 items-center text-xs mb-2">
          <input className="input" placeholder="event type" value={draft.eventType} onChange={(e) => setDraft({ ...draft, eventType: e.target.value })}/>
          <select className="input" value={draft.channel} onChange={(e) => setDraft({ ...draft, channel: e.target.value as "email"|"teams"|"slack" })}>
            <option value="email">email</option><option value="teams">teams</option><option value="slack">slack</option>
          </select>
          <input className="input" placeholder="target (email or webhook URL)" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}/>
          <input className="input font-mono" placeholder='{"riskTier":["high","critical"]}' value={draft.filter} onChange={(e) => setDraft({ ...draft, filter: e.target.value })}/>
          <label className="flex items-center gap-1"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}/> on</label>
          <button className="btn-primary flex items-center gap-1" onClick={save}><Plus size={12}/> upsert</button>
        </div>
      )}
      <table className="w-full text-xs">
        <thead><tr className="text-slate-500 text-left"><th className="py-1 px-2">event</th><th>channel</th><th>target</th><th>filter</th><th>enabled</th><th>updated</th><th></th></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id} className="border-t border-slate-800">
              <td className="py-1 px-2">{r.event_type}</td>
              <td className="flex items-center gap-1 py-1">
                {r.channel === "email" && <Mail size={12}/>}
                {r.channel === "teams" && <MessageSquare size={12}/>}
                {r.channel === "slack" && <Hash size={12}/>}
                {r.channel}
              </td>
              <td className="truncate max-w-[200px]" title={r.target}>{r.target}</td>
              <td className="font-mono text-[11px] truncate max-w-[200px]" title={r.filter_json}>{r.filter_json}</td>
              <td>{r.enabled ? "yes" : "no"}</td>
              <td title={r.updated_at}>{timeAgo(r.updated_at)}</td>
              <td>{isAdmin && <button onClick={() => remove(r)} className="text-red-300 hover:text-red-200"><Trash2 size={12}/></button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

// ── shared chrome ─────────────────────────────────────────────

function Panel({ title, busy, onRefresh, err, ok, clearErr, children }: {
  title: string; busy: boolean; onRefresh: () => void
  err: string | null; ok: string | null; clearErr: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold">{title}</span>
        <button onClick={onRefresh} className="btn-ghost" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>}
        </button>
      </div>
      {err && <div className="px-2 py-1 text-red-300 bg-red-900/30 border border-red-800/40 text-xs flex gap-2 items-center"><AlertCircle size={14}/>{err}<button onClick={clearErr} className="ml-auto"><X size={14}/></button></div>}
      {ok  && <div className="px-2 py-1 text-emerald-300 bg-emerald-900/30 border border-emerald-800/40 text-xs flex gap-2 items-center"><CheckCircle2 size={14}/>{ok}</div>}
      {children}
    </div>
  )
}
