/**
 * SyncProposals — F1.6 dashboard widget.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Toolbar: refresh • trigger run (admin) • status/risk filter│
 *   ├────────────────┬───────────────────────────────────────────┤
 *   │ Proposals list │ Detail: counts / annotation / history /   │
 *   │                │ actions (dismiss, snooze, preview, …)     │
 *   └────────────────┴───────────────────────────────────────────┘
 *
 * SSE-driven: re-fetches on any `sync.proposer.*` or `sync.proposal.*`
 * event observed in the global event log.
 */

import {
    AlertCircle, AlertTriangle, CheckCircle2, Clock, Loader2, Play,
    RefreshCw, ShieldCheck, X,
} from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { useMe } from "../hooks/useMe"
import { useStore } from "../store"
import { timeAgo } from "../util"

const STATUSES = ["open", "awaiting_approval", "previewed", "snoozed", "dismissed", "applied", "superseded", "failed"] as const
const TIERS    = ["low", "medium", "high", "critical"] as const

interface Proposal {
  id:            string
  tenant_id:     string
  source:        string
  target:        string
  entity_type:   string
  entity_id:     string | null
  status:        string
  risk_tier:     string | null
  risk_score:    number | null
  rank_score:    number
  finding_kind:  string
  created_at:    string
  updated_at:    string
  fingerprint:   string
  counts:        { insert: number; update: number; delete: number; unchanged: number; unknown: number }
  annotation:    { rationale?: string; warnings?: Array<{ kind: string; severity?: string }> } | null
}

export function SyncProposals(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const [proposals, setProposals]   = useState<Proposal[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>("open,awaiting_approval,previewed,snoozed")
  const [riskFilter,   setRiskFilter]   = useState<string>("")
  const [source, setSource] = useState("")
  const [target, setTarget] = useState("")
  const [busy, setBusy]     = useState(false)
  const [err,  setErr]      = useState<string | null>(null)
  const [ok,   setOk]       = useState<string | null>(null)

  const proposalEventCount = useStore((s) =>
    s.sseEventLog.filter((e) => typeof e.type === "string" &&
      (e.type.startsWith("sync.proposal") || e.type.startsWith("sync.proposer"))).length,
  )

  const selected = useMemo(
    () => proposals.find((p) => p.id === selectedId) ?? null,
    [proposals, selectedId],
  )

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const rows = await api.listProposals({
        status:   statusFilter || undefined,
        riskTier: riskFilter   || undefined,
        source:   source       || undefined,
        target:   target       || undefined,
      })
      setProposals(rows as unknown as Proposal[])
      const typed = rows as unknown as Proposal[]
      if (!selectedId && typed.length > 0) setSelectedId(typed[0]!.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void refresh() }, [statusFilter, riskFilter, source, target, proposalEventCount])

  async function transition(p: Proposal, to: string, reason?: string): Promise<void> {
    try {
      await api.updateProposalStatus(p.id, { to, reason })
      setOk(`${p.entity_type} → ${to}`)
      setTimeout(() => setOk(null), 2000)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function triggerRun(): Promise<void> {
    if (!source || !target) { setErr("source and target are required"); return }
    try {
      await api.triggerProposerRun(source, target)
      setOk("proposer run triggered")
      setTimeout(() => setOk(null), 2000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function requestApproval(p: Proposal): Promise<void> {
    try {
      await api.createApproval({ proposalId: p.id })
      setOk("approval requested")
      setTimeout(() => setOk(null), 2000)
      await refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="h-full flex flex-col text-sm">
      <Toolbar
        statusFilter={statusFilter} setStatusFilter={setStatusFilter}
        riskFilter={riskFilter}     setRiskFilter={setRiskFilter}
        source={source} setSource={setSource}
        target={target} setTarget={setTarget}
        onRefresh={refresh} busy={busy}
        isAdmin={isAdmin}
        onTrigger={triggerRun}
      />
      {err && <div className="px-3 py-1 text-red-300 bg-red-900/30 border-y border-red-800/40 text-xs flex gap-2 items-center"><AlertCircle size={14}/>{err}<button onClick={() => setErr(null)} className="ml-auto"><X size={14}/></button></div>}
      {ok  && <div className="px-3 py-1 text-emerald-300 bg-emerald-900/30 border-y border-emerald-800/40 text-xs flex gap-2 items-center"><CheckCircle2 size={14}/>{ok}</div>}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(280px,360px)_1fr] gap-2 p-2">
        <ProposalList
          proposals={proposals}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
        <ProposalDetail
          proposal={selected}
          isAdmin={isAdmin}
          onTransition={transition}
          onRequestApproval={requestApproval}
        />
      </div>
    </div>
  )
}

interface ToolbarProps {
  statusFilter: string; setStatusFilter: (s: string) => void
  riskFilter:   string; setRiskFilter:   (s: string) => void
  source: string; setSource: (s: string) => void
  target: string; setTarget: (s: string) => void
  onRefresh: () => void; busy: boolean
  isAdmin: boolean
  onTrigger: () => void
}

function Toolbar(p: ToolbarProps): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 p-2 border-b border-slate-800 text-xs">
      <button onClick={p.onRefresh} className="btn-ghost" disabled={p.busy} title="Refresh">
        {p.busy ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>}
      </button>
      <span className="text-slate-400">status</span>
      <input value={p.statusFilter} onChange={(e) => p.setStatusFilter(e.target.value)}
             className="bg-slate-900 border border-slate-700 px-2 py-1 rounded w-72"
             placeholder={STATUSES.join(",")}/>
      <span className="text-slate-400">risk</span>
      <input value={p.riskFilter} onChange={(e) => p.setRiskFilter(e.target.value)}
             className="bg-slate-900 border border-slate-700 px-2 py-1 rounded w-40"
             placeholder={TIERS.join(",")}/>
      <span className="text-slate-400">src</span>
      <input value={p.source} onChange={(e) => p.setSource(e.target.value)}
             className="bg-slate-900 border border-slate-700 px-2 py-1 rounded w-32"/>
      <span className="text-slate-400">tgt</span>
      <input value={p.target} onChange={(e) => p.setTarget(e.target.value)}
             className="bg-slate-900 border border-slate-700 px-2 py-1 rounded w-32"/>
      {p.isAdmin && (
        <button onClick={p.onTrigger} className="ml-auto btn-primary flex items-center gap-1">
          <Play size={14}/> Run proposer
        </button>
      )}
    </div>
  )
}

function ProposalList({ proposals, selectedId, onSelect }: {
  proposals: Proposal[]; selectedId: string | null; onSelect: (id: string) => void
}): JSX.Element {
  if (proposals.length === 0) {
    return <div className="text-slate-500 text-xs p-3">no proposals match the current filters</div>
  }
  return (
    <ul className="overflow-y-auto border border-slate-800 rounded divide-y divide-slate-800">
      {proposals.map((p) => {
        const tier = p.risk_tier ?? "—"
        const score = p.risk_score ?? "—"
        const sel = p.id === selectedId
        return (
          <li key={p.id}>
            <button onClick={() => onSelect(p.id)}
              className={`w-full text-left px-3 py-2 hover:bg-slate-800/60 ${sel ? "bg-slate-800/80" : ""}`}>
              <div className="flex items-center gap-2">
                <RiskBadge tier={tier}/>
                <span className="font-mono text-[11px] text-slate-400 truncate">{p.source} → {p.target}</span>
                <span className="ml-auto text-[11px] text-slate-500" title={p.created_at}>{timeAgo(p.created_at)}</span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-medium truncate">{p.entity_type}{p.entity_id ? `/${p.entity_id}` : ""}</span>
                <span className="ml-auto text-[11px] text-slate-500">score {String(score)}</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500 flex gap-2">
                <span>i:{p.counts.insert}</span><span>u:{p.counts.update}</span><span>d:{p.counts.delete}</span>
                <span className="ml-auto">{p.status}</span>
              </div>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function ProposalDetail({ proposal, isAdmin, onTransition, onRequestApproval }: {
  proposal: Proposal | null
  isAdmin:  boolean
  onTransition: (p: Proposal, to: string, reason?: string) => Promise<void>
  onRequestApproval: (p: Proposal) => Promise<void>
}): JSX.Element {
  if (!proposal) return <div className="text-slate-500 text-xs p-3 border border-slate-800 rounded">select a proposal</div>
  return (
    <div className="overflow-y-auto border border-slate-800 rounded p-3 space-y-3">
      <header className="flex items-center gap-2">
        <RiskBadge tier={proposal.risk_tier ?? "—"}/>
        <span className="font-semibold">{proposal.entity_type}{proposal.entity_id ? `/${proposal.entity_id}` : ""}</span>
        <span className="text-slate-500 text-xs">{proposal.source} → {proposal.target}</span>
        <span className="ml-auto text-xs text-slate-500" title={proposal.updated_at}>updated {timeAgo(proposal.updated_at)}</span>
      </header>
      <Row label="status">{proposal.status}</Row>
      <Row label="finding">{proposal.finding_kind}</Row>
      <Row label="rank score">{proposal.rank_score.toFixed(1)}</Row>
      <Row label="fingerprint">
        <span className="font-mono text-[11px] break-all">{proposal.fingerprint}</span>
      </Row>
      <Row label="counts">
        i:{proposal.counts.insert} • u:{proposal.counts.update} • d:{proposal.counts.delete} •
        unchanged:{proposal.counts.unchanged} • unknown:{proposal.counts.unknown}
      </Row>
      {proposal.annotation && (
        <div className="rounded border border-slate-800 p-2 space-y-1">
          <div className="text-[11px] text-slate-400">Annotator rationale</div>
          <p className="whitespace-pre-wrap text-xs">{proposal.annotation.rationale}</p>
          {proposal.annotation.warnings && proposal.annotation.warnings.length > 0 && (
            <ul className="text-[11px] flex flex-wrap gap-1 mt-1">
              {proposal.annotation.warnings.map((w, i) => (
                <li key={i} className="px-1.5 py-0.5 rounded bg-amber-900/40 border border-amber-700/40 text-amber-200 flex items-center gap-1">
                  <AlertTriangle size={10}/> {w.kind}{w.severity ? ` (${w.severity})` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
        {isAdmin && (
          <>
            <ActionButton onClick={() => onTransition(proposal, "previewed", "marked previewed")}>Mark previewed</ActionButton>
            <ActionButton onClick={() => onRequestApproval(proposal)}>
              <ShieldCheck size={12}/> Request approval
            </ActionButton>
            <ActionButton onClick={() => {
              const until = prompt("Snooze until (ISO timestamp)", new Date(Date.now() + 24*3600_000).toISOString())
              if (until) void onTransition(proposal, "snoozed")
            }}><Clock size={12}/> Snooze</ActionButton>
            <ActionButton onClick={() => {
              const reason = prompt("Reason for dismissing?", "no longer relevant")
              if (reason) void onTransition(proposal, "dismissed", reason)
            }}>Dismiss</ActionButton>
          </>
        )}
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 text-xs">
      <span className="text-slate-500">{label}</span>
      <span>{children}</span>
    </div>
  )
}

function RiskBadge({ tier }: { tier: string }): JSX.Element {
  const colour =
    tier === "critical" ? "bg-red-900/50 text-red-200 border-red-700/50"   :
    tier === "high"     ? "bg-orange-900/50 text-orange-200 border-orange-700/50" :
    tier === "medium"   ? "bg-amber-900/50 text-amber-200 border-amber-700/50"    :
    tier === "low"      ? "bg-emerald-900/50 text-emerald-200 border-emerald-700/50" :
                          "bg-slate-800 text-slate-400 border-slate-700"
  return <span className={`px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${colour}`}>{tier}</span>
}

function ActionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button onClick={onClick}
      className="px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-xs flex items-center gap-1">
      {children}
    </button>
  )
}
