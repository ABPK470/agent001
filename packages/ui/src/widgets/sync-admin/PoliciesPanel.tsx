/**
 * PoliciesPanel — approval policies per (target env, risk tier).
 *
 * Controls whether a sync run requires no/single/dual approval
 * before promotion.
 */

import { ShieldCheck } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useRef, useState } from "react"
import { api } from "../../api"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { useContainerSize } from "../../hooks/useContainerSize"
import { useMe } from "../../hooks/useMe"
import { HelpBanner, PanelChrome } from "./shared"

interface Policy {
  tenantId: string
  targetEnv: string
  riskTier: string
  policy: "none" | "single" | "dual"
  approvers: string[]
  bypassRole: string | null
}

type Kind = Policy["policy"]

interface Draft {
  targetEnv: string
  riskTier: string
  kind: Kind
  approvers: string
  bypassRole: string
}

const DEFAULT_DRAFT: Draft = {
  targetEnv: "*",
  riskTier: "medium",
  kind: "single",
  approvers: "",
  bypassRole: "admin"
}

const KIND_OPTIONS: ListboxOption<Kind>[] = [
  { value: "none", label: "none" },
  { value: "single", label: "single" },
  { value: "dual", label: "dual" },
]

export function PoliciesPanel(): JSX.Element {
  const layoutRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(layoutRef)
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Policy[]>([])
  const [busy,  setBusy]  = useState(false)
  const [err,   setErr]   = useState<string | null>(null)
  const [ok,    setOk]    = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT)
  const compactForm = width > 0 && width < 900

  useEffect(() => { void refresh() }, [])

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const rows = await api.listApprovalPolicies()
      setItems(rows as unknown as Policy[])
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  async function save(): Promise<void> {
    try {
      await api.upsertApprovalPolicy({
        targetEnv: draft.targetEnv.trim() || "*",
        riskTier: draft.riskTier.trim(),
        kind: draft.kind,
        approvers: draft.approvers.split(",").map((entry) => entry.trim()).filter(Boolean),
        bypassRole: draft.bypassRole.trim() || "admin",
      })
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
      <div ref={layoutRef} className="min-w-0">
        <HelpBanner>
          Policies are keyed by <em>target environment</em> and <em>risk tier</em>.
          <strong> none</strong> = auto-promote, <strong>single</strong> = one approver required,
          <strong> dual</strong> = two distinct approvers. Use <code className="font-mono">*</code> for the default env bucket.
        </HelpBanner>

        {isAdmin && (
          <div className="mx-5 mt-4 rounded-lg border border-border-subtle bg-panel p-3">
            <div className={compactForm ? "grid grid-cols-1 gap-2 text-xs sm:grid-cols-2" : "grid grid-cols-[100px_120px_120px_1fr_120px_auto] items-center gap-2 text-xs"}>
              <input className="input min-w-0 font-mono" value={draft.targetEnv} onChange={(e) => setDraft({ ...draft, targetEnv: e.target.value })} placeholder="target env" />
              <input className="input min-w-0" value={draft.riskTier} onChange={(e) => setDraft({ ...draft, riskTier: e.target.value })} placeholder="risk tier" />
              <Listbox value={draft.kind} options={KIND_OPTIONS} onChange={(kind) => setDraft({ ...draft, kind })} className="min-w-0 w-full" ariaLabel="Approval kind" />
              <input className="input min-w-0 font-mono" value={draft.approvers} onChange={(e) => setDraft({ ...draft, approvers: e.target.value })} placeholder="approvers (comma-separated, optional)" />
              <input className="input min-w-0" value={draft.bypassRole} onChange={(e) => setDraft({ ...draft, bypassRole: e.target.value })} placeholder="bypass role" />
              <button onClick={() => void save()} className={`flex min-h-10 items-center justify-center gap-1 rounded bg-accent px-3 py-1.5 text-[11px] text-text-on-accent hover:bg-accent-hover ${compactForm ? "sm:justify-self-start" : ""}`}>
                <ShieldCheck className="h-3 w-3" /> save policy
              </button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto px-5 py-4">
          <table className="min-w-[640px] w-full text-xs">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-text-muted">
                <th className="px-2 py-1.5">target env</th><th>risk tier</th><th>kind</th><th>approvers</th><th>bypass role</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-6 text-center text-text-faint">No approval policies configured.</td></tr>
              )}
              {items.map((p) => (
                <tr key={`${p.targetEnv}:${p.riskTier}`} className="border-t border-border-subtle">
                  <td className="px-2 py-1.5 font-mono">{p.targetEnv}</td>
                  <td className="font-mono">{p.riskTier}</td>
                  <td><KindBadge kind={p.policy} /></td>
                  <td className="font-mono text-text-muted">{p.approvers.length ? p.approvers.join(", ") : "any non-self"}</td>
                  <td className="font-mono">{p.bypassRole ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </PanelChrome>
  )
}

function KindBadge({ kind }: { kind: Kind }): JSX.Element {
  const cls =
    kind === "none"   ? "bg-overlay-2     text-text-muted   border-border-subtle"
  : kind === "single" ? "bg-info-soft    text-info      border-info/30"
  :                     "bg-warning-soft  text-warning    border-warning/30"
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}>{kind}</span>
}
