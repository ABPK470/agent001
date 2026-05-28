import {
    ShieldAlert,
    ShieldCheck,
    ShieldX
} from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../../api"
import { useMe } from "../../hooks/useMe"
import { useStore } from "../../store"
import { timeAgo } from "../../util"
import { Empty, PanelChrome, SplitView } from "./shared"

interface Approval {
  id: string
  proposal_id: string
  tenant_id: string
  requested_by: string
  requested_at: string
  expires_at: string
  policy: "none" | "single" | "dual"
  state: "pending" | "partially_granted" | "granted" | "rejected" | "expired" | "bypassed"
  granted_by_1: string | null
  granted_by_2: string | null
  granted_at_1: string | null
  granted_at_2: string | null
  rejected_by: string | null
  rejected_at: string | null
  reject_reason: string | null
  bypass_by: string | null
  bypass_reason: string | null
}

const FILTERS = [
  { label: "Open", value: "pending,partially_granted" },
  { label: "Granted", value: "granted" },
  { label: "Rejected", value: "rejected,bypassed,expired" },
] as const

export function ApprovalsPanel(): JSX.Element {
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false
  const [items, setItems] = useState<Approval[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<string>("pending,partially_granted")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const sseTick = useStore((s) => s.sseEventLog.filter((e) => typeof e.type === "string" && e.type.startsWith("sync.approval")).length)
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId])

  async function refresh(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const rows: Approval[] = []
      for (const state of filter.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        const next = await api.listApprovals({ state })
        rows.push(...(next as unknown as Approval[]))
      }
      const seen = new Set<string>()
      const deduped = rows.filter((row) => seen.has(row.id) ? false : (seen.add(row.id), true))
      setItems(deduped)
      if (!selectedId && deduped[0]) setSelectedId(deduped[0].id)
      if (selectedId && !deduped.some((row) => row.id === selectedId)) setSelectedId(deduped[0]?.id ?? null)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => { void refresh() }, [filter, sseTick])

  async function grant(approval: Approval): Promise<void> {
    try {
      await api.grantApproval(approval.id)
      setOk("Approval granted")
      setTimeout(() => setOk(null), 1800)
      await refresh()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    }
  }

  async function reject(approval: Approval): Promise<void> {
    const reason = prompt("Reason for rejection?")
    if (!reason) return
    try {
      await api.rejectApproval(approval.id, reason)
      setOk("Approval rejected")
      setTimeout(() => setOk(null), 1800)
      await refresh()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    }
  }

  async function bypass(approval: Approval): Promise<void> {
    const reason = prompt("Reason for bypass?")
    if (!reason) return
    try {
      await api.bypassApproval(approval.id, reason)
      setOk("Approval bypassed")
      setTimeout(() => setOk(null), 1800)
      await refresh()
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <PanelChrome
      title="Approvals"
      subtitle="The one approval queue for sync proposals and governed promotion decisions."
      busy={busy}
      onRefresh={() => void refresh()}
      err={err}
      ok={ok}
      onClearErr={() => setErr(null)}
      actions={
        <div className="inline-flex rounded-lg border border-border-subtle bg-panel p-0.5">
          {FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              onClick={() => setFilter(entry.value)}
              className={`rounded-md px-3 py-1 text-[11px] transition-colors ${filter === entry.value ? "bg-accent/15 text-accent font-medium" : "text-text-muted hover:text-text"}`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      }
    >
      {items.length === 0 ? (
        <Empty title="No approvals in this filter">
          Approval requests appear here once a sync proposal enters the real approval workflow.
        </Empty>
      ) : (
        <SplitView
          list={items.map((approval) => {
            const active = approval.id === selectedId
            return (
              <button
                key={approval.id}
                type="button"
                onClick={() => setSelectedId(approval.id)}
                className={`flex w-full flex-col items-start gap-1 border-l-2 px-3 py-2 text-left text-xs ${active ? "border-accent bg-overlay-2" : "border-transparent hover:bg-overlay-2"}`}
              >
                <div className="flex w-full items-center gap-2">
                  <StateBadge state={approval.state} />
                  <span className="truncate font-mono text-[11px] text-text-muted">{approval.proposal_id.slice(0, 8)}…</span>
                  <span className="ml-auto text-[10px] text-text-faint">{timeAgo(approval.requested_at)}</span>
                </div>
                <div className="text-text">{approval.requested_by}</div>
                <div className="text-[10px] text-text-faint">policy {approval.policy} · expires {timeAgo(approval.expires_at)}</div>
              </button>
            )
          })}
          detail={<ApprovalDetail approval={selected} isAdmin={isAdmin} onGrant={grant} onReject={reject} onBypass={bypass} />}
        />
      )}
    </PanelChrome>
  )
}

function ApprovalDetail({
  approval,
  isAdmin,
  onGrant,
  onReject,
  onBypass,
}: {
  approval: Approval | null
  isAdmin: boolean
  onGrant: (approval: Approval) => Promise<void>
  onReject: (approval: Approval) => Promise<void>
  onBypass: (approval: Approval) => Promise<void>
}): JSX.Element {
  if (!approval) return <Empty title="Pick an approval">Select an approval from the queue to review its status and actions.</Empty>

  const expired = new Date(approval.expires_at).getTime() < Date.now()
  const actionable = !expired && (approval.state === "pending" || approval.state === "partially_granted")

  return (
    <div className="space-y-4 p-5 text-xs">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={approval.state} />
          <span className="font-mono text-[11px] text-text-muted">{approval.id}</span>
        </div>
        <p className="max-w-2xl text-[12px] leading-6 text-text-muted">
          This queue is the real sync approval workflow. Grant, reject, or bypass here affects the stored approval record directly.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Info label="Proposal" value={approval.proposal_id} />
        <Info label="Tenant" value={approval.tenant_id} />
        <Info label="Policy" value={approval.policy} />
        <Info label="Requested by" value={`${approval.requested_by} · ${timeAgo(approval.requested_at)}`} />
        <Info label="Expires" value={`${approval.expires_at}${expired ? " · expired" : ""}`} />
        <Info label="Grant status" value={renderGrantStatus(approval)} />
      </div>

      {approval.reject_reason && (
        <Callout tone="error" title="Rejected">
          {approval.rejected_by}: {approval.reject_reason}
        </Callout>
      )}
      {approval.bypass_reason && (
        <Callout tone="warn" title="Bypassed">
          {approval.bypass_by}: {approval.bypass_reason}
        </Callout>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3">
        {actionable ? (
          <>
            <button
              type="button"
              onClick={() => void onGrant(approval)}
              className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[12px] text-emerald-100 hover:bg-emerald-500/20"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Grant
            </button>
            <button
              type="button"
              onClick={() => void onReject(approval)}
              className="flex items-center gap-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-[12px] text-rose-100 hover:bg-rose-500/20"
            >
              <ShieldX className="h-3.5 w-3.5" /> Reject
            </button>
            {isAdmin && (
              <button
                type="button"
                onClick={() => void onBypass(approval)}
                className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-100 hover:bg-amber-500/20"
              >
                <ShieldAlert className="h-3.5 w-3.5" /> Bypass
              </button>
            )}
          </>
        ) : (
          <div className="text-[12px] text-text-muted">This approval is no longer actionable.</div>
        )}
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-border-subtle bg-panel px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-1 break-all text-[12px] text-text">{value || "—"}</div>
    </div>
  )
}

function Callout({ tone, title, children }: { tone: "warn" | "error"; title: string; children: string }): JSX.Element {
  const cls = tone === "warn"
    ? "border-amber-500/30 bg-amber-500/10 text-amber-100"
    : "border-rose-500/30 bg-rose-500/10 text-rose-100"
  return (
    <div className={`rounded-lg border px-4 py-3 text-[12px] leading-6 ${cls}`}>
      <div className="mb-1 font-medium">{title}</div>
      <div>{children}</div>
    </div>
  )
}

function StateBadge({ state }: { state: Approval["state"] }): JSX.Element {
  const colour =
    state === "granted" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100" :
    state === "rejected" ? "border-rose-500/30 bg-rose-500/10 text-rose-100" :
    state === "expired" ? "border-border-subtle bg-panel text-text-muted" :
    state === "bypassed" ? "border-amber-500/30 bg-amber-500/10 text-amber-100" :
    state === "partially_granted" ? "border-sky-500/30 bg-sky-500/10 text-sky-100" :
    "border-border-subtle bg-overlay-2 text-text"
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${colour}`}>{state.replaceAll("_", " ")}</span>
}

function renderGrantStatus(approval: Approval): string {
  const first = approval.granted_by_1 ? `${approval.granted_by_1}${approval.granted_at_1 ? ` (${timeAgo(approval.granted_at_1)})` : ""}` : "—"
  const second = approval.policy === "dual"
    ? ` • ${approval.granted_by_2 ? `${approval.granted_by_2}${approval.granted_at_2 ? ` (${timeAgo(approval.granted_at_2)})` : ""}` : "—"}`
    : ""
  return `${first}${second}`
}