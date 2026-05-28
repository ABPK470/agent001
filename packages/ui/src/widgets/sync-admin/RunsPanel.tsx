import { Activity, Clock, Eye, ShieldCheck } from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"

import { api } from "../../api"
import type { SyncPlan } from "../../types"
import { timeAgo } from "../../util"
import { DetailRow, Empty, ListItem, PanelChrome, SplitView } from "./shared"

interface SyncRunRow {
  planId: string
  entityType: string
  entityId: string
  entityDisplayName: string | null
  source: string
  target: string
  actorUpn: string | null
  status: "started" | "success" | "failed"
  error: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

export function RunsPanel(): JSX.Element {
  const [items, setItems] = useState<SyncRunRow[]>([])
  const [busy, setBusy] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planErr, setPlanErr] = useState<string | null>(null)

  useEffect(() => { void load() }, [])

  useEffect(() => {
    if (!selected) {
      setPlan(null)
      setPlanErr(null)
      return
    }
    let cancelled = false
    setPlanBusy(true)
    setPlanErr(null)
    api.syncPlan(selected)
      .then((next) => {
        if (cancelled) return
        if (next.error) {
          setPlan(null)
          setPlanErr(next.error)
          return
        }
        setPlan(next)
      })
      .catch((error) => {
        if (cancelled) return
        setPlan(null)
        setPlanErr(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        if (!cancelled) setPlanBusy(false)
      })
    return () => { cancelled = true }
  }, [selected])

  async function load(): Promise<void> {
    setBusy(true)
    setErr(null)
    try {
      const next = await api.syncRuns(100)
      setItems(next)
      if (!selected && next[0]) setSelected(next[0].planId)
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const chosen = useMemo(() => items.find((item) => item.planId === selected) ?? null, [items, selected])

  return (
    <PanelChrome
      title="Runs & Explainability"
      subtitle="Persisted sync runs, compiled plan snapshots, governance decisions, and decision logs."
      busy={busy}
      onRefresh={() => void load()}
      err={err}
      onClearErr={() => setErr(null)}
    >
      {items.length === 0 ? (
        <Empty title="No sync runs yet">Preview and execute activity will appear here once the platform persists runs.</Empty>
      ) : (
        <SplitView
          list={items.map((item) => (
            <ListItem key={item.planId} active={item.planId === selected} onClick={() => setSelected(item.planId)}>
              <div className="flex w-full items-center justify-between gap-2">
                <span className="truncate font-mono">{item.entityDisplayName ?? `${item.entityType}#${item.entityId}`}</span>
                <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusTone(item.status)}`}>{item.status}</span>
              </div>
              <span className="text-text-muted">{item.source} → {item.target}</span>
              <span className="text-[10px] text-text-faint">{timeAgo(item.finishedAt ?? item.startedAt)} · {item.actorUpn ?? "system"}</span>
            </ListItem>
          ))}
          detail={chosen ? <RunDetail run={chosen} plan={plan} busy={planBusy} err={planErr} /> : <Empty title="Pick a run" />}
        />
      )}
    </PanelChrome>
  )
}

function RunDetail({ run, plan, busy, err }: { run: SyncRunRow; plan: SyncPlan | null; busy: boolean; err: string | null }): JSX.Element {
  const decisionLog = plan?.decisionLog ?? []
  const governance = plan?.governanceDecision ?? null
  const executionContract = plan?.executionContract ?? null

  return (
    <div className="space-y-5 p-5 text-xs">
      <header>
        <h3 className="text-sm font-semibold text-text">{run.entityDisplayName ?? `${run.entityType}#${run.entityId}`}</h3>
        <p className="font-mono text-[11px] text-text-faint">{run.planId} · {run.source} → {run.target}</p>
      </header>

      <section className="rounded-lg border border-border-subtle bg-panel p-4">
        <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          <Activity className="h-3 w-3" /> run snapshot
        </h4>
        <div className="overflow-x-auto">
          <dl className="grid min-w-[320px] grid-cols-[140px_1fr] gap-x-4 gap-y-1.5">
            <DetailRow label="status" value={<span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${statusTone(run.status)}`}>{run.status}</span>} />
            <DetailRow label="actor" value={run.actorUpn ?? "system"} />
            <DetailRow label="started" value={formatDateTime(run.startedAt)} />
            <DetailRow label="finished" value={run.finishedAt ? formatDateTime(run.finishedAt) : "running"} />
            <DetailRow label="duration" value={run.durationMs == null ? "—" : `${Math.round(run.durationMs / 1000)}s`} />
            <DetailRow label="error" value={run.error ?? "—"} />
          </dl>
        </div>
      </section>

      {busy && <div className="rounded-lg border border-border-subtle bg-panel px-4 py-3 text-text-muted">Loading persisted plan…</div>}
      {err && <div className="rounded-lg border border-warning/20 bg-warning/5 px-4 py-3 text-warning">Could not load plan snapshot: {err}</div>}

      {plan && executionContract && (
        <section className="rounded-lg border border-border-subtle bg-panel p-4">
          <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            <Eye className="h-3 w-3" /> compiled plan
          </h4>
          <div className="overflow-x-auto">
            <dl className="grid min-w-[320px] grid-cols-[140px_1fr] gap-x-4 gap-y-1.5">
              <DetailRow label="definition" value={executionContract.definitionId} />
              <DetailRow label="version" value={executionContract.definitionVersion} />
              <DetailRow label="schemas" value={executionContract.allowedSchemas.join(", ") || "—"} />
              <DetailRow label="steps" value={String(executionContract.steps.length)} />
            </dl>
          </div>
          <div className="mt-3 space-y-2">
            {executionContract.steps.map((step, index) => (
              <div key={step.id} className="rounded border border-border-subtle bg-overlay-1/40 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-text-muted/45">{index + 1}</span>
                  <span className="font-medium text-text">{step.title}</span>
                  <span className="ml-auto rounded border border-border-subtle px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">{step.phase}</span>
                </div>
                <div className="mt-1 text-text-muted">{step.description}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {plan && governance && (
        <section className="rounded-lg border border-border-subtle bg-panel p-4">
          <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            <ShieldCheck className="h-3 w-3" /> governance decision
          </h4>
          <div className="overflow-x-auto">
            <dl className="grid min-w-[320px] grid-cols-[140px_1fr] gap-x-4 gap-y-1.5">
              <DetailRow label="evaluated" value={formatDateTime(governance.evaluatedAt)} />
              <DetailRow label="approval policy" value={governance.governance.approvalPolicyId ?? "none"} />
              <DetailRow label="risk multiplier" value={String(governance.governance.riskMultiplier)} />
              <DetailRow label="target role" value={governance.targetEnvironment.role} />
              <DetailRow label="actor allowed" value={governance.targetEnvironment.actorAllowed === null ? "not evaluated" : (governance.targetEnvironment.actorAllowed ? "yes" : "no")} />
              <DetailRow label="freeze refs" value={governance.governance.freezeWindowIds.join(", ") || "none"} />
            </dl>
          </div>
          {governance.warnings.length > 0 && (
            <div className="mt-3 rounded border border-warning/20 bg-warning/5 px-3 py-2 text-warning">
              {governance.warnings.map((warning) => <div key={warning}>• {warning}</div>)}
            </div>
          )}
        </section>
      )}

      {plan && (
        <section className="rounded-lg border border-border-subtle bg-panel p-4">
          <h4 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            <Clock className="h-3 w-3" /> decision log
          </h4>
          {decisionLog.length === 0 ? (
            <div className="text-text-muted">No persisted decision records on this plan.</div>
          ) : (
            <div className="space-y-2">
              {decisionLog.map((decision) => (
                <div key={decision.id} className="rounded border border-border-subtle bg-overlay-1/40 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${decisionSeverityTone(decision.severity)}`}>{decision.severity}</span>
                    <span className="font-medium text-text">{decision.title}</span>
                    <span className="ml-auto text-[10px] uppercase tracking-wide text-text-muted">{decision.category}</span>
                  </div>
                  <div className="mt-1 text-text-muted">{decision.summary}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function statusTone(status: SyncRunRow["status"]): string {
  switch (status) {
    case "success":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
    case "failed":
      return "border-rose-500/40 bg-rose-500/10 text-rose-200"
    default:
      return "border-border-subtle bg-overlay-2 text-text-muted"
  }
}

function decisionSeverityTone(severity: string): string {
  switch (severity) {
    case "error":
      return "bg-rose-500/15 text-rose-200"
    case "warning":
      return "bg-amber-500/15 text-amber-200"
    default:
      return "bg-accent/15 text-accent"
  }
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}