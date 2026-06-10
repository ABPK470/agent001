import { ArrowRight, ChevronDown, ChevronRight, Clock, RefreshCw, View } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { api, OperationKind, OperationStatus, type OperationPipeline } from "../../api"
import { useStore } from "../../store"
import type { SyncPlan } from "../../types"
import { timeAgo } from "../../util"
import { EmptyHistory, Err, Loading } from "./chrome"
import { DIFF } from "./constants"
import { HistoryPlanTables } from "./PlanTables"

type SyncHistoryEventRow = {
  id: string
  phase: "preview" | "execute"
  label: string
  timestamp: string
  status: OperationStatus
  summary?: string
  error?: string
  raw: unknown
}

type SyncHistoryGroup = {
  planId: string
  firstAt: string
  lastAt: string
  entityLabel: string
  route: string | null
  status: "preview" | "executing" | "completed" | "failed"
  preview?: OperationPipeline
  execute?: OperationPipeline
  totals?: { insert: number; update: number; delete: number } | null
  isAgent: boolean
  events: SyncHistoryEventRow[]
}

export function HistoryContent({ onOpen }: { onOpen?: (planId: string) => void }) {
  const [pipelines, setPipelines] = useState<OperationPipeline[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  function reload() {
    setErr(null)
    api.operations({ limit: 500 }).then((result) => {
      setPipelines(result.operations.filter((operation) => operation.kind === "sync-preview" || operation.kind === "sync-execute"))
    }).catch((error) => setErr(error instanceof Error ? error.message : String(error)))
  }

  useEffect(reload, [])

  const agentSyncExec = useStore((s) => s.agentSyncExec)
  const agentSyncExecStarted = useStore((s) => s.agentSyncExecStarted)
  const syncFormPlanId = useStore((s) => s.envSyncForm.planId)
  const prevPlanIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (syncFormPlanId && syncFormPlanId !== prevPlanIdRef.current) {
      prevPlanIdRef.current = syncFormPlanId
      reload()
    }
  }, [syncFormPlanId])

  useEffect(() => {
    if (agentSyncExecStarted) reload()
  }, [agentSyncExecStarted])

  useEffect(() => {
    if (agentSyncExec) reload()
  }, [agentSyncExec])

  if (err) return <Err>{err}</Err>
  if (!pipelines) return <Loading>Loading history…</Loading>
  if (!pipelines.length) return <EmptyHistory />

  const groups = groupSyncHistory(pipelines)

  return (
    <div>
      <div className="flex items-center justify-between text-sm text-text-muted px-4 py-2 border-b border-border/40">
        <span>{groups.length} sync run{groups.length === 1 ? "" : "s"}</span>
        <button onClick={reload} className="hover:text-text" title="Refresh"><RefreshCw size={16} /></button>
      </div>
      {groups.map((group) => <HistoryPlanRow key={group.planId} group={group} onOpen={onOpen} />)}
    </div>
  )
}

function groupSyncHistory(pipelines: OperationPipeline[]): SyncHistoryGroup[] {
  const groups = new Map<string, SyncHistoryGroup>()
  for (const pipeline of pipelines) {
    const planId = pipeline.id
    const existing = groups.get(planId)
    const titleParts = pipeline.title.split(" — ")
    const entityLabel = titleParts[1] ?? pipeline.title
    const route = pipeline.subtitle && pipeline.subtitle !== planId.slice(0, 8) ? pipeline.subtitle : null
    const pipelineEvents = flattenPipelineEvents(pipeline)
    const isAgent = pipelineEvents.some((event) => {
      const raw = event.raw as { data?: Record<string, unknown> } | undefined
      const data = raw && typeof raw === "object" && "data" in raw ? raw.data : null
      return !!data && typeof data === "object" && data["runId"] != null
    })

    if (!existing) {
      groups.set(planId, {
        planId,
        firstAt: pipeline.startedAt,
        lastAt: pipeline.endedAt ?? pipeline.startedAt,
        entityLabel,
        route,
        status: deriveHistoryStatus(undefined, pipeline),
        preview: pipeline.kind === OperationKind.SyncPreview ? pipeline : undefined,
        execute: pipeline.kind === OperationKind.SyncExecute ? pipeline : undefined,
        totals: extractPipelineTotals(pipeline),
        isAgent,
        events: pipelineEvents,
      })
      continue
    }

    existing.firstAt = existing.firstAt < pipeline.startedAt ? existing.firstAt : pipeline.startedAt
    const pipelineLastAt = pipeline.endedAt ?? pipeline.startedAt
    existing.lastAt = existing.lastAt > pipelineLastAt ? existing.lastAt : pipelineLastAt
    existing.route = existing.route ?? route
    existing.isAgent = existing.isAgent || isAgent
    if (pipeline.kind === OperationKind.SyncPreview) existing.preview = pipeline
    if (pipeline.kind === OperationKind.SyncExecute) existing.execute = pipeline
    existing.totals = extractPipelineTotals(pipeline) ?? existing.totals
    existing.events.push(...pipelineEvents)
    existing.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    existing.status = deriveHistoryStatus(existing, pipeline)
  }

  return [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

function deriveHistoryStatus(existing: SyncHistoryGroup | undefined, pipeline: OperationPipeline): SyncHistoryGroup["status"] {
  const statuses = [existing?.preview?.status, existing?.execute?.status, pipeline.status]
  if (statuses.includes(OperationStatus.Failed)) return "failed"
  if (statuses.includes(OperationStatus.Running)) return pipeline.kind === OperationKind.SyncExecute ? "executing" : "preview"
  if (pipeline.kind === OperationKind.SyncExecute || existing?.execute) return "completed"
  return "preview"
}

function flattenPipelineEvents(pipeline: OperationPipeline): SyncHistoryEventRow[] {
  return pipeline.activities.map((activity, index) => ({
    id: `${pipeline.id}:${activity.id}:${index}`,
    phase: pipeline.kind === OperationKind.SyncPreview ? "preview" : "execute",
    label: formatHistoryActivityName(activity.name, pipeline.kind),
    timestamp: activity.startedAt,
    status: activity.status,
    summary: activity.summary,
    error: activity.error,
    raw: activity.events.length === 1 ? activity.events[0] : activity.events,
  }))
}

function extractPipelineTotals(pipeline: OperationPipeline): { insert: number; update: number; delete: number } | null {
  for (const activity of pipeline.activities) {
    for (const event of activity.events) {
      const data = event.data
      const totals = data["totals"] as Record<string, unknown> | undefined
      const applied = data["applied"] as Record<string, unknown> | undefined
      const source = totals ?? applied
      if (!source) continue
      const insert = Number(source["insert"] ?? 0)
      const update = Number(source["update"] ?? 0)
      const del = Number(source["delete"] ?? 0)
      return { insert, update, delete: del }
    }
  }
  return null
}

function splitHistoryEvents(group: SyncHistoryGroup): { preview: SyncHistoryEventRow[]; execute: SyncHistoryEventRow[] } {
  return {
    preview: group.events.filter((event) => event.phase === "preview"),
    execute: group.events.filter((event) => event.phase === "execute"),
  }
}

function HistoryPlanRow({ group, onOpen }: { group: SyncHistoryGroup; onOpen?: (planId: string) => void }) {
  const [open, setOpen] = useState(false)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [planErr, setPlanErr] = useState<string | null>(null)
  const statusTone = historyGroupTone(group.status)
  const sections = splitHistoryEvents(group)
  const entityLabel = plan ? formatPlanEntityLabel(plan) : group.entityLabel
  const routeLabel = plan ? `${plan.source} → ${plan.target}` : group.route

  useEffect(() => {
    if (!open || plan || planErr) return
    let cancelled = false
    api.syncPlan(group.planId)
      .then((next) => {
        if (cancelled || next.error) return
        setPlan(next)
      })
      .catch((error) => {
        if (cancelled) return
        setPlanErr(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [group.planId, open, plan, planErr])

  return (
    <div className="border-b border-border/40">
      <button onClick={() => setOpen((value) => !value)} className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-elevated/30 transition-colors text-sm">
        {open ? <ChevronDown size={13} className="text-text-muted" /> : <ChevronRight size={13} className="text-text-muted" />}
        <span className={`w-2 h-2 shrink-0${group.isAgent ? "" : " rounded-full"}`} style={{ background: statusTone }} title={group.isAgent ? "agent" : "manual"} />
        <span className="text-text font-mono truncate flex-1">
          {entityLabel}
          {group.isAgent && <span className="ml-1 text-[10px] text-accent/70 font-sans">(agent)</span>}
        </span>
        <span className="hidden md:flex items-center gap-1.5 shrink-0">
          {group.preview && <span className="px-2 py-0.5 rounded border border-border-subtle text-[11px] text-text-muted bg-overlay-1">Preview</span>}
          {group.execute && <span className="px-2 py-0.5 rounded border border-border-subtle text-[11px] text-text-muted bg-overlay-1">Execute</span>}
        </span>
        {routeLabel && <span className="text-text-muted font-mono flex items-center gap-1">{routeLabel.split(" → ")[0]}<ArrowRight size={10} className="opacity-60" />{routeLabel.split(" → ")[1]}</span>}
        {group.totals && <span className="font-mono tabular-nums flex gap-2">
          {group.totals.insert > 0 && <span style={{ color: DIFF.ins }}>{group.totals.insert} ins</span>}
          {group.totals.update > 0 && <span style={{ color: DIFF.upd }}>{group.totals.update} upd</span>}
          {group.totals.delete > 0 && <span style={{ color: DIFF.del }}>{group.totals.delete} del</span>}
        </span>}
        <span className="text-text-muted capitalize">{group.status}</span>
        <span className="text-text-muted flex items-center gap-1"><Clock size={11} />{timeAgo(group.lastAt)}</span>
      </button>
      {open && (
        <div className="px-4 py-3 bg-base/30 border-t border-border/30 text-sm space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-text-muted/50 font-mono">
              <span>plan</span>
              <span className="text-text-muted">{group.planId}</span>
            </div>
            <div className="flex items-center gap-2">
              {group.preview && <span className="px-2 py-0.5 rounded border border-border-subtle text-[11px] text-text-muted">Preview</span>}
              {group.execute && <span className="px-2 py-0.5 rounded border border-border-subtle text-[11px] text-text-muted">Execute</span>}
              {onOpen && (
                <button
                  type="button"
                  className="text-text-muted hover:text-accent/80 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpen(group.planId)
                  }}
                  title="View plan"
                >
                  <View size={16} />
                </button>
              )}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <HistoryKv label="Entity" value={entityLabel} />
            <HistoryKv label="Route" value={routeLabel ?? "—"} />
            <HistoryKv label="Started" value={formatHistoryDateTime(group.firstAt)} />
            <HistoryKv label="Updated" value={formatHistoryDateTime(group.lastAt)} />
          </div>

          {planErr && (
            <div className="rounded-lg border border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning">
              Could not load persisted plan details: {planErr}
            </div>
          )}

          {plan && (
            <div className="rounded-lg border border-border-subtle overflow-hidden">
              <div className="max-h-[28rem] overflow-y-auto">
                <HistoryPlanTables plan={plan} />
              </div>
            </div>
          )}

          <div className="space-y-3">
            {sections.preview.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted/50">Preview</div>
                {sections.preview.map((event) => (
                  <HistoryEventRow key={event.id} event={event} />
                ))}
              </div>
            )}
            {sections.execute.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-[11px] uppercase tracking-[0.16em] text-text-muted/50">Execute</div>
                {sections.execute.map((event) => (
                  <HistoryEventRow key={event.id} event={event} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function HistoryEventRow({ event }: { event: SyncHistoryEventRow }) {
  const [jsonOpen, setJsonOpen] = useState(false)
  const hasJson = event.raw != null
  const actionColor = event.status === OperationStatus.Failed ? DIFF.del
    : event.status === OperationStatus.Success ? DIFF.ins
      : event.status === OperationStatus.Running ? "var(--color-accent)"
        : undefined

  return (
    <div className="rounded border border-border-subtle bg-overlay-1">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wide text-text-muted/45 shrink-0">{event.phase}</span>
        <span className="text-xs font-medium shrink-0" style={actionColor ? { color: actionColor } : undefined}>{event.label}</span>
        {event.summary && <span className="text-xs text-text-muted truncate">{event.summary}</span>}
        <span className="flex-1" />
        <span className="text-xs text-text-muted/40 font-mono tabular-nums">{new Date(event.timestamp).toLocaleTimeString()}</span>
        {hasJson && (
          <button
            onClick={() => setJsonOpen((value) => !value)}
            className="text-xs text-text-muted/40 hover:text-text-muted px-1 py-0.5 rounded hover:bg-elevated transition-colors"
          >
            {jsonOpen ? "hide" : "json"}
          </button>
        )}
      </div>
      {event.error && (
        <div className="px-3 pb-2 text-xs font-mono break-all" style={{ color: DIFF.del }}>
          {event.error}
        </div>
      )}
      {hasJson && jsonOpen && (
        <div className="px-3 pb-2 border-t border-border-subtle">
          <pre className="text-xs text-text-muted/60 font-mono whitespace-pre-wrap break-all leading-relaxed pt-1.5 max-h-48 overflow-y-auto show-scrollbar">
            {JSON.stringify(event.raw, null, 2)}
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

function historyGroupTone(status: SyncHistoryGroup["status"]): string {
  switch (status) {
    case "completed": return DIFF.ins
    case "failed": return DIFF.del
    case "executing": return "var(--color-accent)"
    default: return "var(--color-text-muted)"
  }
}

function formatHistoryActivityName(name: string, kind: OperationKind): string {
  const map: Record<string, string> = {
    started: kind === OperationKind.SyncPreview ? "Preview started" : "Execute started",
    completed: kind === OperationKind.SyncPreview ? "Preview complete" : "Execute complete",
    failed: kind === OperationKind.SyncPreview ? "Preview failed" : "Execute failed",
    "sync-metadata": "Sync Metadata",
    "sync-date": "Set Sync Date",
    "deploy-etl": "Deploy ETL",
    "publish-views": "Publish Views",
    "apply-contract": "Apply Contract",
    "apply-rules": "Apply Rules",
    phases: kind === OperationKind.SyncPreview ? "Preview phases" : "Execution phases",
  }
  if (map[name]) return map[name]
  return name
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function formatHistoryDateTime(value: string): string {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function formatPlanEntityLabel(plan: SyncPlan): string {
  const entityRef = `${plan.entity.type}#${plan.entity.id}`
  return plan.entity.displayName ? `${plan.entity.displayName} (${entityRef})` : entityRef
}