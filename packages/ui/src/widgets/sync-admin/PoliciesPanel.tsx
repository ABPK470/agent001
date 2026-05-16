/**
 * PoliciesPanel — approval policies per (target env, risk tier).
 *
 * Controls whether a sync run requires no/single/dual approval
 * before promotion, the request TTL, and whether the requester
 * can self-grant.
 */

import { ShieldCheck } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useState } from "react"
import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import { HelpBanner, PanelChrome } from "./shared"

interface Policy {
  tenant_id:            string
  risk_tier:            string
  kind:                 "none" | "single" | "dual"
  ttl_ms:               number
  allow_self_requester: number
  bypass_role:          string | null
}

type Kind = "none" | "single" | "dual"

interface Draft { riskTier: string; kind: Kind; ttlMs: number; allowSelfRequester: boolean; bypassRole: string }

const DEFAULT_DRAFT: Draft = { riskTier: "medium", kind: "single", ttlMs: 86_400_000, allowSelfRequester: false, bypassRole: "admin" }

export function PoliciesPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Policy[]>([])
  const [busy,  setBusy]  = useState(false)
  const [err,   setErr]   = useState<string | null>(null)
  const [ok,    setOk]    = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT)

  useEffect(() => { void refresh() }, [])

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try { setItems((await api.listApprovalPolicies()) as unknown as Policy[]) }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function save(): Promise<void> {
    try {
      await api.upsertApprovalPolicy(draft)
      setOk("policy saved"); setTimeout(() => setOk(null), 1500)
      await refresh()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <PanelChrome
      title="Approval policies"
      subtitle="Who must approve a sync run before it promotes to its target environment."
      busy={busy} onRefresh={refresh} err={err} ok={ok} onClearErr={() => setErr(null)}
    >
      <HelpBanner>
        Policies are keyed by <em>risk tier</em>. <strong>none</strong> = auto-promote, <strong>single</strong> = one
        approver required, <strong>dual</strong> = two distinct approvers. TTL caps how long a pending request lives
        before it expires.
      </HelpBanner>

      {isAdmin && (
        <div className="mx-5 mt-4 rounded-lg border border-border-subtle bg-panel p-3">
          <div className="grid grid-cols-[120px_120px_160px_160px_auto_auto] items-center gap-2 text-xs">
            <input className="input" value={draft.riskTier} onChange={(e) => setDraft({ ...draft, riskTier: e.target.value })} placeholder="risk tier (low/medium/high/critical)" />
            <select className="input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}>
              <option value="none">none</option>
              <option value="single">single</option>
              <option value="dual">dual</option>
            </select>
            <input className="input" type="number" value={draft.ttlMs} onChange={(e) => setDraft({ ...draft, ttlMs: Number(e.target.value) })} placeholder="TTL ms" />
            <input className="input" value={draft.bypassRole} onChange={(e) => setDraft({ ...draft, bypassRole: e.target.value })} placeholder="bypass role" />
            <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
              <input type="checkbox" checked={draft.allowSelfRequester} onChange={(e) => setDraft({ ...draft, allowSelfRequester: e.target.checked })} />
              allow self
            </label>
            <button onClick={() => void save()} className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-[11px] text-text-on-accent hover:bg-accent-hover">
              <ShieldCheck className="h-3 w-3" /> save policy
            </button>
          </div>
        </div>
      )}

      <div className="px-5 py-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-text-muted">
              <th className="px-2 py-1.5">risk tier</th><th>kind</th><th>TTL</th><th>self-grant</th><th>bypass role</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-text-faint">No approval policies configured.</td></tr>
            )}
            {items.map((p) => (
              <tr key={p.risk_tier} className="border-t border-border-subtle">
                <td className="px-2 py-1.5 font-mono">{p.risk_tier}</td>
                <td><KindBadge kind={p.kind} /></td>
                <td className="text-text-muted">{formatMs(p.ttl_ms)}</td>
                <td>{p.allow_self_requester ? "yes" : "no"}</td>
                <td className="font-mono">{p.bypass_role ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </PanelChrome>
  )
}

function KindBadge({ kind }: { kind: Kind }): JSX.Element {
  const cls =
    kind === "none"   ? "bg-overlay-2     text-text-muted   border-border-subtle"
  : kind === "single" ? "bg-sky-500/15    text-sky-200      border-sky-500/40"
  :                     "bg-amber-500/15  text-amber-200    border-amber-500/40"
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>{kind}</span>
}

function formatMs(ms: number): string {
  if (ms <= 0) return "—"
  const h = Math.round(ms / 3_600_000)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
