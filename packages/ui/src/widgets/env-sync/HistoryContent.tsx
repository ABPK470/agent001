import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, Clock, RefreshCw, View } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

import { api } from "../../api"
import { useStore } from "../../store"
import type { SyncPlan } from "../../types"
import { timeAgo } from "../../util"
import { EmptyHistory, Err, Loading } from "./chrome"
import { DIFF } from "./constants"
import { formatPlanEntityLabel } from "./workflow"
import { HistoryPlanTables } from "./PlanTables"

const PAGE_SIZE = 25

type SyncRunItem = Awaited<ReturnType<typeof api.syncHistory>>["items"][number]

type SyncAuditEvent = Awaited<ReturnType<typeof api.syncHistoryDetail>>["audit"][number]

type RunStatus = SyncRunItem["status"]

function entityLabel(run: SyncRunItem): string {
  const ref = `${run.entityType}#${run.entityId}`
  return run.entityDisplayName ? `${run.entityDisplayName} (${ref})` : ref
}

function runStatusTone(status: RunStatus): string {
  switch (status) {
    case "success":
      return DIFF.ins
    case "failed":
      return DIFF.del
    case "started":
      return "var(--color-accent)"
    default:
      return "var(--color-text-muted)"
  }
}

function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case "success":
      return "completed"
    case "failed":
      return "failed"
    case "started":
      return "executing"
    default:
      return "preview"
  }
}

function formatAuditAction(action: string): string {
  const map: Record<string, string> = {
    "sync.preview": "Preview",
    "sync.execute.start": "Execute started",
    "sync.execute.completed": "Execute completed",
    "sync.execute.skipped": "Execute skipped (audit gate)",
    "sync.execute.failed": "Execute failed"
  }
  return map[action] ?? action
}

export function HistoryContent({ onOpen }: { onOpen?: (planId: string) => void }) {
  const [page, setPage] = useState(1)
  const [data, setData] = useState<Awaited<ReturnType<typeof api.syncHistory>> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback((nextPage = page) => {
    setErr(null)
    setLoading(true)
    api
      .syncHistory(nextPage, PAGE_SIZE)
      .then((result) => {
        setData(result)
        setPage(result.page)
      })
      .catch((error) => setErr(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }, [page])

  useEffect(() => {
    reload(1)
  }, [])

  const agentSyncExec = useStore((s) => s.agentSyncExec)
  const agentSyncExecStarted = useStore((s) => s.agentSyncExecStarted)
  const syncFormPlanId = useStore((s) => s.envSyncForm.planId)
  const prevPlanIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (syncFormPlanId && syncFormPlanId !== prevPlanIdRef.current) {
      prevPlanIdRef.current = syncFormPlanId
      reload(1)
    }
  }, [syncFormPlanId, reload])

  useEffect(() => {
    if (agentSyncExecStarted) reload(1)
  }, [agentSyncExecStarted, reload])

  useEffect(() => {
    if (agentSyncExec) reload(page)
  }, [agentSyncExec, page, reload])

  if (err) return <Err>{err}</Err>
  if (loading && !data) return <Loading>Loading history…</Loading>
  if (!data || data.items.length === 0) return <EmptyHistory />

  const { items, total, totalPages } = data
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1
  const rangeEnd = Math.min(page * PAGE_SIZE, total)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex shrink-0 items-center justify-between text-sm text-text-muted px-4 py-2 border-b border-border/40 gap-3">
        <span>
          {total === 0 ? "No runs" : `${rangeStart}–${rangeEnd} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => reload(page - 1)}
            className="p-1 rounded hover:text-text disabled:opacity-30"
            title="Previous page"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="font-mono text-xs tabular-nums">
            {page}{totalPages > 0 ? ` / ${totalPages}` : ""}
          </span>
          <button
            type="button"
            disabled={page >= totalPages || loading}
            onClick={() => reload(page + 1)}
            className="p-1 rounded hover:text-text disabled:opacity-30"
            title="Next page"
          >
            <ChevronRight size={16} />
          </button>
          <button
            type="button"
            onClick={() => reload(page)}
            className="p-1 rounded hover:text-text"
            title="Refresh"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
          </button>
        </div>
      </div>
      {items.map((run) => (
        <HistoryRunRow key={run.planId} run={run} onOpen={onOpen} />
      ))}
    </div>
  )
}

function HistoryRunRow({ run, onOpen }: { run: SyncRunItem; onOpen?: (planId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const [audit, setAudit] = useState<SyncAuditEvent[] | null>(null)
  const [auditErr, setAuditErr] = useState<string | null>(null)

  const totals = run.executeTotals ?? run.previewTotals
  const label = plan ? formatPlanEntityLabel(plan) : entityLabel(run)

  useEffect(() => {
    if (!open) return
    let cancelled = false

    if (!audit && !auditErr) {
      api
        .syncHistoryDetail(run.planId)
        .then((detail) => {
          if (!cancelled) setAudit(detail.audit)
        })
        .catch((error) => {
          if (!cancelled) setAuditErr(error instanceof Error ? error.message : String(error))
        })
    }

    if (run.planAvailable && !plan && !planErr) {
      api
        .syncPlan(run.planId)
        .then((next) => {
          if (cancelled || next.error) return
          setPlan(next)
        })
        .catch((error) => {
          if (!cancelled) setPlanErr(error instanceof Error ? error.message : String(error))
        })
    }

    return () => {
      cancelled = true
    }
  }, [open, run.planId, run.planAvailable, plan, planErr, audit, auditErr])

  return (
    <div className="border-b border-border/40">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-elevated/30 transition-colors text-sm"
      >
        {open ? (
          <ChevronDown size={13} className="text-text-muted shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-text-muted shrink-0" />
        )}
        <span
          className="w-2 h-2 shrink-0 rounded-full"
          style={{ background: runStatusTone(run.status) }}
          title={run.status}
        />
        <span className="text-text font-mono truncate flex-1">{label}</span>
        <span className="text-text-muted font-mono flex items-center gap-1 shrink-0">
          {run.source}
          <ArrowRight size={10} className="opacity-60" />
          {run.target}
        </span>
        <span className="font-mono tabular-nums flex gap-2 shrink-0">
          {totals.insert > 0 && <span style={{ color: DIFF.ins }}>{totals.insert} ins</span>}
          {totals.update > 0 && <span style={{ color: DIFF.upd }}>{totals.update} upd</span>}
          {totals.delete > 0 && <span style={{ color: DIFF.del }}>{totals.delete} del</span>}
        </span>
        <span className="text-text-muted capitalize shrink-0">{runStatusLabel(run.status)}</span>
        <span className="text-text-muted flex items-center gap-1 shrink-0">
          <Clock size={11} />
          {timeAgo(run.finishedAt ?? run.startedAt)}
        </span>
      </button>

      {open && (
        <div className="px-4 py-3 bg-base/30 border-t border-border/30 text-sm space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-text-muted/50 font-mono min-w-0">
              <span className="shrink-0">plan</span>
              <span className="text-text-muted truncate">{run.planId}</span>
            </div>
            {onOpen && run.planAvailable && (
              <button
                type="button"
                className="text-text-muted hover:text-accent/80 transition-colors shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  onOpen(run.planId)
                }}
                title="View plan"
              >
                <View size={16} />
              </button>
            )}
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <HistoryKv label="Entity" value={label} />
            <HistoryKv label="Route" value={`${run.source} → ${run.target}`} />
            <HistoryKv label="Actor" value={run.actorUpn ?? "—"} />
            <HistoryKv label="Started" value={formatHistoryDateTime(run.startedAt)} />
            {run.finishedAt && <HistoryKv label="Finished" value={formatHistoryDateTime(run.finishedAt)} />}
            {run.durationMs != null && (
              <HistoryKv label="Duration" value={`${(run.durationMs / 1000).toFixed(1)}s`} />
            )}
          </div>

          {run.error && (
            <div className="rounded-lg border border-error/20 bg-error/5 px-3 py-2 text-xs font-mono break-all text-error">
              {run.error}
            </div>
          )}

          {planErr && (
            <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning">
              Could not load persisted plan: {planErr}
            </div>
          )}

          {plan && (
            <div className="rounded-lg border border-border-subtle overflow-hidden">
              <div className="max-h-[28rem] overflow-y-auto">
                <HistoryPlanTables plan={plan} />
              </div>
            </div>
          )}

          {auditErr && (
            <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning">
              Could not load audit trail: {auditErr}
            </div>
          )}

          {audit && audit.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted/50">Audit</div>
              {audit.map((event, index) => (
                <HistoryAuditRow key={`${event.action}:${event.timestamp}:${index}`} event={event} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryAuditRow({ event }: { event: SyncAuditEvent }) {
  const [jsonOpen, setJsonOpen] = useState(false)
  const failed = event.action.endsWith(".failed")
  const completed = event.action.endsWith(".completed")
  const actionColor = failed ? DIFF.del : completed ? DIFF.ins : undefined

  return (
    <div className="rounded border border-border-subtle bg-overlay-1">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-xs font-medium shrink-0" style={actionColor ? { color: actionColor } : undefined}>
          {formatAuditAction(event.action)}
        </span>
        <span className="text-xs text-text-muted truncate">{event.actor}</span>
        <span className="flex-1" />
        <span className="text-xs text-text-muted/40 font-mono tabular-nums">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
        {event.detail != null && (
          <button
            type="button"
            onClick={() => setJsonOpen((value) => !value)}
            className="text-xs text-text-muted/40 hover:text-text-muted px-1 py-0.5 rounded hover:bg-elevated transition-colors"
          >
            {jsonOpen ? "hide" : "json"}
          </button>
        )}
      </div>
      {jsonOpen && event.detail != null && (
        <div className="px-3 pb-2 border-t border-border-subtle">
          <pre className="text-xs text-text-muted/60 font-mono whitespace-pre-wrap break-all leading-relaxed pt-1.5 max-h-48 overflow-y-auto show-scrollbar">
            {JSON.stringify(event.detail, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

function HistoryKv({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/40 bg-overlay-1/50 px-3 py-2 min-w-0">
      <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted/55">{label}</div>
      <div className="mt-1 text-sm text-text font-mono leading-5 break-all">{value}</div>
    </div>
  )
}

function formatHistoryDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })
}