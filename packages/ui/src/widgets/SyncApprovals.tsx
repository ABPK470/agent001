/**
 * SyncApprovals — F1.7 dashboard widget.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Toolbar: refresh • state filter                            │
 *   ├────────────────┬───────────────────────────────────────────┤
 *   │ Approval list  │ Detail: requester, expiry, plan hash,     │
 *   │                │ actions (grant, reject, bypass)           │
 *   └────────────────┴───────────────────────────────────────────┘
 *
 * Subscribes to `sync.approval.*` SSE events.
 */

import {
    AlertCircle, CheckCircle2, Loader2, RefreshCw, ShieldAlert,
    ShieldCheck, ShieldX, X,
} from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import { timeAgo } from "../util"

interface Approval {
  id:              string
  proposal_id:     string
  tenant_id:       string
  requested_by:    string
  requested_at:    string
  expires_at:      string
  policy:          "none" | "single" | "dual"
  state:           "pending" | "partially_granted" | "granted" | "rejected" | "expired" | "bypassed"
  granted_by_1:    string | null
  granted_by_2:    string | null
  granted_at_1:    string | null
  granted_at_2:    string | null
  rejected_by:     string | null
  rejected_at:     string | null
  reject_reason:   string | null
  bypass_by:       string | null
  bypass_reason:   string | null
}

const STATES = ["pending", "partially_granted", "granted", "rejected", "expired", "bypassed"] as const

export function SyncApprovals(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Approval[]>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [state, setState] = useState<string>("pending,partially_granted")
  const [busy, setBusy]   = useState(false)
  const [err,  setErr]    = useState<string | null>(null)
  const [ok,   setOk]     = useState<string | null>(null)

  const sseTick = useStore((s) =>
    s.sseEventLog.filter((e) => typeof e.type === "string" && e.type.startsWith("sync.approval")).length,
  )

  const selected = useMemo(() => items.find((i) => i.id === selId) ?? null, [items, selId])

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const rows: Approval[] = []
      for (const s of state.split(",").map((x) => x.trim()).filter(Boolean)) {
        const r = await api.listApprovals({ state: s })
        rows.push(...(r as unknown as Approval[]))
      }
      // dedupe by id (the loop above queries per state)
      const seen = new Set<string>()
      const dedup = rows.filter((r) => seen.has(r.id) ? false : (seen.add(r.id), true))
      setItems(dedup)
      if (!selId && dedup.length > 0) setSelId(dedup[0]!.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void refresh() }, [state, sseTick])

  async function grant(a: Approval): Promise<void> {
    try { await api.grantApproval(a.id); setOk("granted"); setTimeout(() => setOk(null), 2000); await refresh() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function reject(a: Approval): Promise<void> {
    const reason = prompt("Reason for rejection?")
    if (!reason) return
    try { await api.rejectApproval(a.id, reason); setOk("rejected"); setTimeout(() => setOk(null), 2000); await refresh() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }
  async function bypass(a: Approval): Promise<void> {
    const reason = prompt("Reason for bypass (admin-only emergency)?")
    if (!reason) return
    try { await api.bypassApproval(a.id, reason); setOk("bypassed"); setTimeout(() => setOk(null), 2000); await refresh() }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="h-full flex flex-col text-sm">
      <div className="flex items-center gap-2 p-2 border-b border-slate-800 text-xs">
        <button onClick={refresh} className="btn-ghost" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>}
        </button>
        <span className="text-slate-400">state</span>
        <input value={state} onChange={(e) => setState(e.target.value)}
               className="bg-slate-900 border border-slate-700 px-2 py-1 rounded w-72"
               placeholder={STATES.join(",")}/>
      </div>
      {err && <div className="px-3 py-1 text-red-300 bg-red-900/30 border-y border-red-800/40 text-xs flex gap-2 items-center"><AlertCircle size={14}/>{err}<button onClick={() => setErr(null)} className="ml-auto"><X size={14}/></button></div>}
      {ok  && <div className="px-3 py-1 text-emerald-300 bg-emerald-900/30 border-y border-emerald-800/40 text-xs flex gap-2 items-center"><CheckCircle2 size={14}/>{ok}</div>}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(280px,360px)_1fr] gap-2 p-2">
        <ApprovalList items={items} selectedId={selId} onSelect={setSelId}/>
        <ApprovalDetail
          a={selected} isAdmin={isAdmin}
          onGrant={grant} onReject={reject} onBypass={bypass}
        />
      </div>
    </div>
  )
}

function ApprovalList({ items, selectedId, onSelect }: {
  items: Approval[]; selectedId: string | null; onSelect: (id: string) => void
}): JSX.Element {
  if (items.length === 0) return <div className="text-slate-500 text-xs p-3">no approvals match</div>
  return (
    <ul className="overflow-y-auto border border-slate-800 rounded divide-y divide-slate-800">
      {items.map((a) => {
        const sel = a.id === selectedId
        return (
          <li key={a.id}>
            <button onClick={() => onSelect(a.id)}
              className={`w-full text-left px-3 py-2 hover:bg-slate-800/60 ${sel ? "bg-slate-800/80" : ""}`}>
              <div className="flex items-center gap-2">
                <StateBadge state={a.state}/>
                <span className="text-[11px] text-slate-400 font-mono truncate">{a.proposal_id.slice(0, 8)}…</span>
                <span className="ml-auto text-[11px] text-slate-500" title={a.requested_at}>{timeAgo(a.requested_at)}</span>
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                policy: {a.policy} • by {a.requested_by} • expires {timeAgo(a.expires_at)}
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ApprovalDetail({ a, isAdmin, onGrant, onReject, onBypass }: {
  a: Approval | null; isAdmin: boolean
  onGrant:  (a: Approval) => Promise<void>
  onReject: (a: Approval) => Promise<void>
  onBypass: (a: Approval) => Promise<void>
}): JSX.Element {
  if (!a) return <div className="text-slate-500 text-xs p-3 border border-slate-800 rounded">select an approval</div>
  const expired = new Date(a.expires_at).getTime() < Date.now()
  const actionable = !expired && (a.state === "pending" || a.state === "partially_granted")
  return (
    <div className="overflow-y-auto border border-slate-800 rounded p-3 space-y-3 text-xs">
      <header className="flex items-center gap-2">
        <StateBadge state={a.state}/>
        <span className="font-mono text-slate-400">{a.id}</span>
      </header>
      <Row label="proposal">{a.proposal_id}</Row>
      <Row label="tenant">{a.tenant_id}</Row>
      <Row label="policy">{a.policy}</Row>
      <Row label="requested by">{a.requested_by} <span className="text-slate-500">({timeAgo(a.requested_at)})</span></Row>
      <Row label="expires">{a.expires_at} {expired && <span className="text-red-400 ml-1">expired</span>}</Row>
      <Row label="grants">
        {a.granted_by_1 ?? "—"}{a.granted_at_1 ? ` (${timeAgo(a.granted_at_1)})` : ""}
        {a.policy === "dual" && (
          <> • {a.granted_by_2 ?? "—"}{a.granted_at_2 ? ` (${timeAgo(a.granted_at_2)})` : ""}</>
        )}
      </Row>
      {a.reject_reason && <Row label="rejection">{a.rejected_by}: {a.reject_reason}</Row>}
      {a.bypass_reason && <Row label="bypass">{a.bypass_by}: {a.bypass_reason}</Row>}
      <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
        {actionable && (
          <>
            <button onClick={() => onGrant(a)} className="px-2 py-1 rounded border border-emerald-700 hover:bg-emerald-900/30 flex items-center gap-1">
              <ShieldCheck size={12}/> Grant
            </button>
            <button onClick={() => onReject(a)} className="px-2 py-1 rounded border border-red-700 hover:bg-red-900/30 flex items-center gap-1">
              <ShieldX size={12}/> Reject
            </button>
            {isAdmin && (
              <button onClick={() => onBypass(a)} className="px-2 py-1 rounded border border-amber-700 hover:bg-amber-900/30 flex items-center gap-1">
                <ShieldAlert size={12}/> Bypass
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <span className="text-slate-500">{label}</span>
      <span>{children}</span>
    </div>
  )
}

function StateBadge({ state }: { state: string }): JSX.Element {
  const colour =
    state === "granted"           ? "bg-emerald-900/50 text-emerald-200 border-emerald-700/50" :
    state === "rejected"          ? "bg-red-900/50 text-red-200 border-red-700/50" :
    state === "expired"           ? "bg-slate-800 text-slate-400 border-slate-700" :
    state === "bypassed"          ? "bg-amber-900/50 text-amber-200 border-amber-700/50" :
    state === "partially_granted" ? "bg-blue-900/50 text-blue-200 border-blue-700/50" :
                                    "bg-slate-700/50 text-slate-200 border-slate-600/50"
  return <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${colour}`}>{state}</span>
}
