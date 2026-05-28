/**
 * Operation Log — three-level history of platform activity, live via SSE.
 *
 * Data source: GET /api/operations/stream (SSE, no polling).
 * Filters: multi-select kind + status chips, free-text search.
 * Layout: operations grouped by day.
 */

import { ChevronRight, Database, Loader2, Search, Settings, VenetianMask, X, XCircle } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { OperationActivity, OperationEvent, OperationPipeline, OperationsResponse } from "../api"
import { api, OperationKind, OperationStatus } from "../api"
import { useContainerSize } from "../hooks/useContainerSize"

// ── Visuals ──────────────────────────────────────────────────────

const KIND_META: Record<OperationKind, { label: string; Icon: typeof VenetianMask; color: string }> = {
  "agent-run":    { label: "agent",   Icon: VenetianMask, color: "var(--color-accent)" },
  "sync-preview": { label: "preview", Icon: Database, color: "var(--color-info)" },
  "sync-execute": { label: "execute", Icon: Database, color: "var(--color-success)" },
  "system":       { label: "system",  Icon: Settings, color: "var(--color-text-muted)" },
}

const STATUS_META: Record<OperationStatus, { color: string; tone: string }> = {
  running:   { color: "var(--color-info)", tone: "bg-info-soft text-info" },
  success:   { color: "var(--color-success)", tone: "bg-success-soft text-success" },
  failed:    { color: "var(--color-error)", tone: "bg-error-soft text-error" },
  cancelled: { color: "var(--color-text-muted)", tone: "bg-overlay-2 text-text-muted" },
  unknown:   { color: "var(--color-text-muted)", tone: "bg-overlay-2 text-text-muted" },
}

// system kind is intentionally excluded from the ops log — those events live in the Event Stream widget
const ALL_STATUSES: OperationStatus[] = ["running", "success", "failed", "cancelled"]

type KindView = "all" | "agent" | "sync"

// ── Helpers ──────────────────────────────────────────────────────

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

function fmtTime(iso: string): string {
  // Render as local HH:MM:SS for readability
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour12: false })
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, { hour12: false })
}

// ── Component ────────────────────────────────────────────────────

function dayLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "Unknown"
  const today     = new Date(); today.setHours(0,0,0,0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const day       = new Date(d); day.setHours(0,0,0,0)
  if (day.getTime() === today.getTime()) return "Today"
  if (day.getTime() === yesterday.getTime()) return "Yesterday"
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

function matchesPipeline(p: OperationPipeline, needle: string): boolean {
  if (!needle) return true
  const hay = [
    p.title, p.subtitle ?? "", p.id, p.error ?? "",
    ...p.activities.map(a => `${a.name} ${a.summary ?? ""} ${a.error ?? ""}`),
    ...p.activities.flatMap(a => a.events.map(e => e.type)),
  ].join(" ").toLowerCase()
  return hay.includes(needle)
}

function humanizeToken(value: string): string {
  return value
    .replace(/[_\.]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

const EXEC_STEP_DESCRIPTIONS: Record<string, string> = {
  "audit-check": "Run pre-deploy validation on the target metadata.",
  lock: "Lock the contract while deployment is in progress.",
  "sync-metadata": "Apply metadata row changes on the target environment.",
  "sync-metadata-done": "Metadata transaction committed successfully.",
  "pipeline-register": "Register or refresh the pipeline in the Agent service.",
  undeploy: "Remove previously deployed artifacts marked for replacement.",
  "unlock-after-undeploy": "Release the contract lock after undeploy completes.",
  "audit-check-2": "Re-run validation after undeploy before redeploying.",
  "lock-for-deploy": "Acquire the deployment lock for the build phase.",
  "deploy-pre-script": "Run pre-deployment SQL scripts.",
  "create-dataset-stage": "Create or alter stage datasets.",
  "create-dataset-archive": "Create or alter archive datasets.",
  "create-dataset-list": "Create or alter list datasets.",
  "create-dataset-dim": "Create or alter dimension datasets.",
  "create-dataset-fact": "Create or alter fact datasets.",
  "create-fks": "Reconcile foreign keys for deployed datasets.",
  "deploy-etl": "Create or update ETL procedures, views, and functions.",
  "deploy-routine": "Create or update routines and triggers.",
  "handle-dependencies": "Refresh dependent objects after metadata changes.",
  "meta-refresh": "Refresh gate metadata on the target service.",
  "pipeline-start": "Trigger the registered pipeline on the target service.",
  "sync-date": "Stamp the target row sync date.",
  "deploy-date": "Stamp the target row deploy date.",
  "contract-deploy": "Run the full contract deployment sequence.",
  "dataset-deploy": "Trigger dataset deployment in ETL.",
  "rules-deploy": "Trigger rule deployment in ETL.",
}

function formatActivityName(pipelineKind: OperationKind, activity: OperationActivity): string {
  if (pipelineKind !== OperationKind.SyncExecute) return activity.name
  if (activity.name === "phases" || activity.name === "other events" || activity.name.startsWith("tbl:")) return activity.name
  if (activity.name.includes(" (")) return activity.name
  return humanizeToken(activity.name)
}

function defaultActivitySummary(pipelineKind: OperationKind, activity: OperationActivity): string | undefined {
  if (activity.summary) return activity.summary
  if (pipelineKind === OperationKind.SyncExecute) {
    return EXEC_STEP_DESCRIPTIONS[activity.name] ?? undefined
  }
  return undefined
}

function formatEventLabel(ev: OperationEvent): string {
  switch (ev.type) {
    case "sync.preview.completed": return "Preview complete"
    case "sync.preview.table.start": return "Table scan"
    case "sync.preview.table.done": return "Table diff"
    case "sync.preview.table.failed": return "Table failed"
    case "sync.execute.started": return "Execute started"
    case "sync.execute.step": return "Step"
    case "sync.execute.step.failed": return "Step failed"
    case "sync.execute.table.start": return "Table apply"
    case "sync.execute.table.done": return "Table done"
    case "sync.execute.sql": return "SQL"
    case "sync.execute.archive.probe": return "Archive probe"
    case "sync.execute.archive.probe.batch": return "Archive probe batch"
    case "sync.execute.archive.skipped": return "Archive skipped"
    case "sync.execute.drift.revalidated": return "Drift check"
    case "sync.execute.completed": return "Execute complete"
    case "sync.execute.failed": return "Execute failed"
    default: return ev.type
  }
}

export function OperationLog() {
  const [pipelines, setPipelines] = useState<OperationPipeline[]>([])
  const [kindView, setKindView] = useState<KindView>("all")
  const [statuses, setStatuses] = useState<Set<OperationStatus>>(new Set())
  const [search, setSearch] = useState("")
  // full-history deep search (BE scan of all events)
  const [histLoading, setHistLoading] = useState(false)
  const [histResults, setHistResults] = useState<OperationPipeline[] | null>(null)
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [actExpanded, setActExpanded] = useState<Set<string>>(new Set())
  const [evExpanded, setEvExpanded] = useState<Set<string>>(new Set())
  // day group collapse state: empty = all expanded
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(rootRef)
  const compact = width > 0 && width < 640

  // ── SSE ──────────────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource("/api/operations/stream", { withCredentials: true })
    es.onopen    = () => { /* connected */ }
    es.onerror   = () => { /* reconnecting */ }
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data as string) as OperationsResponse
        if (Array.isArray(data.operations)) setPipelines(data.operations)
      } catch { /* ignore */ }
    }
    return () => es.close()
  }, [])

  // ── Full-history search (debounced, fires when SSE results are sparse) ──
  useEffect(() => {
    if (histTimer.current) clearTimeout(histTimer.current)
    if (!search || search.length < 2) { setHistResults(null); return }
    histTimer.current = setTimeout(async () => {
      setHistLoading(true)
      try {
        const res = await api.operations({ limit: 5000, search })
        // also strip system from history results
        setHistResults(res.operations.filter(p => p.kind !== "system"))
      } catch { /* ignore */ } finally {
        setHistLoading(false)
      }
    }, 800)
    return () => { if (histTimer.current) clearTimeout(histTimer.current) }
  }, [search])

  // ── Toggle helpers ────────────────────────────────────────────
  const toggleStatus = useCallback((s: OperationStatus) => {
    setStatuses(prev => { const n = new Set(prev); n.has(s) ? n.delete(s) : n.add(s); return n })
  }, [])
  const togglePipeline = useCallback((id: string) => {
    setExpanded(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  }, [])
  const toggleActivity = useCallback((key: string) => {
    setActExpanded(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  }, [])
  const toggleEvent = useCallback((key: string) => {
    setEvExpanded(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  }, [])
  const toggleDay = useCallback((label: string) => {
    setCollapsedDays(s => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n })
  }, [])

  // ── Filtering — system kind is always excluded ────────────────
  const needle = search.trim().toLowerCase()
  // exclude system pipelines; they belong in the Event Stream widget
  const nonSystem = useMemo(() =>
    (histResults ?? pipelines).filter(p => p.kind !== "system")
  , [histResults, pipelines])

  const filtered = useMemo(() => nonSystem.filter(p => {
    if (kindView === "agent" && p.kind !== "agent-run") return false
    if (kindView === "sync" && p.kind !== "sync-preview" && p.kind !== "sync-execute") return false
    if (statuses.size > 0 && !statuses.has(p.status)) return false
    // When histResults are active, BE already applied the search; local needle is redundant
    if (needle && !histResults && !matchesPipeline(p, needle)) return false
    return true
  }), [nonSystem, kindView, statuses, needle, histResults])

  return (
    <div ref={rootRef} className="h-full flex flex-col gap-2.5 overflow-hidden text-text">

      {/* ── Toolbar ─────────────────────────────────────── */}
      <div className="rounded-lg border border-border-subtle bg-overlay-1 shrink-0">
        <div className={`px-3 py-2 ${compact ? "space-y-2.5" : "flex items-center gap-1.5"}`}>

          <div className={`min-w-0 ${compact ? "flex flex-wrap items-center gap-1.5" : "flex items-center gap-1.5 flex-1 min-w-0"}`}>
            {/* Kind: all | agent | synchronization */}
            {(["all", "agent", "sync"] as const).map(v => {
              const active = v === kindView
              const label  = v === "sync" ? "synchronization" : v
              return (
                <button key={v} onClick={() => setKindView(v)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors whitespace-nowrap ${
                    active ? "bg-accent/15 text-accent font-medium" : "text-text-muted hover:text-text-secondary hover:bg-elevated/40"
                  }`}
                >{label}</button>
              )
            })}

            <div className={`bg-overlay-3 shrink-0 ${compact ? "hidden" : "h-4 w-px mx-1"}`} />

            {/* Status chips */}
            {ALL_STATUSES.map(s => {
              const on = statuses.has(s)
              const m  = STATUS_META[s]
              return (
                <button key={s} onClick={() => toggleStatus(s)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-md transition-colors whitespace-nowrap ${
                    on ? `${m.tone} font-medium` : "text-text-muted hover:text-text-secondary hover:bg-elevated/40"
                  }`}
                >{s}</button>
              )
            })}

            {statuses.size > 0 && (
              <button onClick={() => setStatuses(new Set())}
                className="p-1.5 rounded-md transition-colors text-text-muted/60 hover:text-text hover:bg-elevated/40 shrink-0"
                title="Clear status filters"
              ><X size={14} /></button>
            )}
          </div>

          <div className={`min-w-0 ${compact ? "flex items-center gap-2" : "flex items-center gap-1.5 shrink-0"}`}>
            {!compact && <div className="flex-1 min-w-0" />}

            {/* Search — big, fills remaining space */}
            <div className={`relative flex items-center min-w-0 ${compact ? "flex-1" : "flex-1 max-w-md shrink-0"}`}>
              <Search size={13} className="absolute left-2.5 text-text-muted/50 pointer-events-none" />
              <input
                type="text"
                placeholder="Filter operations…"
                value={search}
                onChange={e => { setSearch(e.target.value); if (!e.target.value) setHistResults(null) }}
                className="pl-8 pr-7 py-1.5 h-[32px] w-full text-[13px] bg-base border border-border rounded-md text-text placeholder:text-text-muted/50 outline-none focus:border-accent transition-colors"
              />
              {histLoading && <Loader2 size={12} className="absolute right-2.5 animate-spin text-text-muted/40" />}
              {search && !histLoading && (
                <button className="absolute right-2 text-text-muted hover:text-text"
                  onClick={() => { setSearch(""); setHistResults(null) }}>
                  <X size={13} />
                </button>
              )}
            </div>

            {/* Count: filtered / total-non-system */}
            <span className="text-[12px] text-text-muted tabular-nums shrink-0 px-1.5">
              {filtered.length !== nonSystem.length
                ? <>{filtered.length}<span className="text-text-muted/40">/{nonSystem.length}</span></>
                : nonSystem.length}
            </span>
          </div>

        </div>
      </div>

      {/* ── Body ────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto pr-1">
        {histLoading && (
          <div className="text-text-muted/60 text-xs text-center py-4">Searching full history…</div>
        )}

        {!histLoading && filtered.length === 0 && (
          <div className="text-text-muted text-center pt-12 text-sm">
            {pipelines.length === 0 ? "No operations recorded yet." : "No matches."}
          </div>
        )}

        {!histLoading && filtered.length > 0 && (
          <OperationPipelineList
            pipelines={filtered}
            compact={compact}
            expanded={expanded}
            togglePipeline={togglePipeline}
            actExpanded={actExpanded}
            toggleActivity={toggleActivity}
            evExpanded={evExpanded}
            toggleEvent={toggleEvent}
            collapsedDays={collapsedDays}
            toggleDay={toggleDay}
          />
        )}
      </div>
    </div>
  )
}

export function OperationPipelineList({
  pipelines,
  compact,
  expanded,
  togglePipeline,
  actExpanded,
  toggleActivity,
  evExpanded,
  toggleEvent,
  collapsedDays,
  toggleDay,
  onOpenSyncPlan,
}: {
  pipelines: OperationPipeline[]
  compact: boolean
  expanded: Set<string>
  togglePipeline: (id: string) => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
  collapsedDays: Set<string>
  toggleDay: (label: string) => void
  onOpenSyncPlan?: (planId: string) => void
}) {
  const byDay = useMemo(() => {
    const groups: Array<{ label: string; items: OperationPipeline[] }> = []
    let cur: { label: string; items: OperationPipeline[] } | null = null
    for (const p of pipelines) {
      const label = dayLabel(p.startedAt)
      if (!cur || cur.label !== label) { cur = { label, items: [] }; groups.push(cur) }
      cur.items.push(p)
    }
    return groups
  }, [pipelines])

  return <>
    {byDay.map(group => {
      const collapsed = collapsedDays.has(group.label)
      return (
        <div key={group.label} className="mb-3">
          <button
            className="sticky top-0 z-10 w-full flex items-center gap-1.5 px-2 py-1 mb-1 text-[10px] uppercase tracking-wider text-text-muted/50 bg-surface/80 backdrop-blur-sm hover:text-text-muted/80 transition-colors text-left"
            onClick={() => toggleDay(group.label)}
          >
            <ChevronRight size={10} className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
            {group.label}
            <span className="ml-1 text-text-muted/30 normal-case tracking-normal">{group.items.length}</span>
          </button>
          {!collapsed && (
            <div className="space-y-1">
              {group.items.map(p => (
                <PipelineRow
                  key={p.id}
                  pipeline={p}
                  expanded={expanded.has(p.id)}
                  onToggle={() => togglePipeline(p.id)}
                  actExpanded={actExpanded}
                  toggleActivity={toggleActivity}
                  evExpanded={evExpanded}
                  toggleEvent={toggleEvent}
                  compact={compact}
                  onOpenSyncPlan={onOpenSyncPlan}
                />
              ))}
            </div>
          )}
        </div>
      )
    })}
  </>
}

// ── Pipeline row ─────────────────────────────────────────────────

function PipelineRow({ pipeline, expanded, onToggle, actExpanded, toggleActivity, evExpanded, toggleEvent, compact, onOpenSyncPlan }: {
  pipeline: OperationPipeline
  expanded: boolean
  onToggle: () => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
  compact: boolean
  onOpenSyncPlan?: (planId: string) => void
}) {
  const km = KIND_META[pipeline.kind]
  const sm = STATUS_META[pipeline.status]
  const Icon = km.Icon

  return (
    <div className="rounded-md border border-border-subtle bg-overlay-1 overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-overlay-2 transition-colors text-left"
        onClick={onToggle}
      >
        <ChevronRight size={14} className={`shrink-0 text-text-muted/60 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Icon size={14} className="shrink-0" style={{ color: km.color }} />
        <span className={`shrink-0 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${sm.tone}`}>
          {pipeline.status === "running" && <Loader2 size={9} className="inline mr-0.5 animate-spin" />}
          {pipeline.status}
        </span>
        <span className="min-w-0 truncate text-[13px] text-text">{pipeline.title}</span>

        {pipeline.subtitle && !compact && (
          <span className="shrink-0 text-[11px] text-text-muted/60 font-mono truncate max-w-[14rem]">{pipeline.subtitle}</span>
        )}
        <div className="flex-1 min-w-0" />
        <span className="shrink-0 text-[11px] text-text-muted/60 tabular-nums">
          {pipeline.activityCount} act · {pipeline.eventCount} ev
        </span>
        <span className="shrink-0 text-[11px] text-text-muted tabular-nums w-16 text-right">{fmtDuration(pipeline.durationMs)}</span>
        <span className="shrink-0 text-[11px] text-text-muted/50 tabular-nums w-20 text-right">{fmtTime(pipeline.startedAt)}</span>
      </button>

      {expanded && (
        <div className="border-t border-border-subtle bg-base/40 px-2 py-1.5 space-y-0.5">
          {onOpenSyncPlan && (pipeline.kind === OperationKind.SyncPreview || pipeline.kind === OperationKind.SyncExecute) && (
            <div className="px-2.5 py-1">
              <button
                className="text-[11px] font-mono text-text-muted hover:text-accent transition-colors"
                onClick={() => onOpenSyncPlan(pipeline.id)}
              >
                view plan {pipeline.id.slice(0, 8)}
              </button>
            </div>
          )}
          {pipeline.error && (
            <div className="px-2.5 py-1.5 mb-1 rounded bg-error-soft border border-error/30 text-[12px] text-error break-all">
              {pipeline.error}
            </div>
          )}
          {pipeline.activities.length === 0 && (
            <div className="px-2.5 py-2 text-[12px] text-text-muted/60">No activities recorded.</div>
          )}
          {pipeline.activities.map((a) => {
            const key = `${pipeline.id}|${a.id}`
            return (
              <ActivityRow
                key={a.id}
                activity={a}
                pipelineKind={pipeline.kind}
                pipelineId={pipeline.id}
                expanded={actExpanded.has(key)}
                onToggle={() => toggleActivity(key)}
                evExpanded={evExpanded}
                toggleEvent={toggleEvent}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Activity row ─────────────────────────────────────────────────

function ActivityRow({ activity, pipelineKind, pipelineId, expanded, onToggle, evExpanded, toggleEvent }: {
  activity: OperationActivity
  pipelineKind: OperationKind
  pipelineId: string
  expanded: boolean
  onToggle: () => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
}) {
  const sm = STATUS_META[activity.status]
  const StatusIcon = activity.status === "failed" ? XCircle
    : activity.status === "running" ? Loader2 : null
  const renderedName = formatActivityName(pipelineKind, activity)
  const renderedSummary = defaultActivitySummary(pipelineKind, activity)

  return (
    <div className="rounded border border-border-subtle">
      <button
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-overlay-2 transition-colors text-left"
        onClick={onToggle}
      >
        <ChevronRight size={12} className={`shrink-0 text-text-muted/60 transition-transform ${expanded ? "rotate-90" : ""}`} />
        {StatusIcon && (
          <StatusIcon
            size={11}
            className={`shrink-0 ${activity.status === "running" ? "animate-spin" : ""}`}
            style={{ color: sm.color }}
          />
        )}
        {!StatusIcon && <span className="w-[11px] h-[11px] rounded-full shrink-0" style={{ background: sm.color, opacity: 0.6 }} />}
        <span className="min-w-0 truncate text-[12px] text-text font-mono">{renderedName}</span>
        {renderedSummary && (
          <span className="shrink-0 text-[11px] text-text-muted/70 truncate max-w-[18rem]">{renderedSummary}</span>
        )}
        <div className="flex-1 min-w-0" />
        <span className="shrink-0 text-[11px] text-text-muted/60 tabular-nums">{activity.events.length} ev</span>
        <span className="shrink-0 text-[11px] text-text-muted tabular-nums w-14 text-right">{fmtDuration(activity.durationMs)}</span>
        <span className="shrink-0 text-[11px] text-text-muted/50 tabular-nums w-20 text-right">{fmtTime(activity.startedAt)}</span>
      </button>

      {expanded && (
        <div className="border-t border-border-subtle px-2.5 py-1.5 space-y-0.5 bg-base/30">
          {activity.error && (
            <div className="px-2 py-1 mb-1 rounded bg-error-soft border border-error/30 text-[11px] text-error break-all">
              {activity.error}
            </div>
          )}
          {activity.events.map((ev, idx) => {
            const key = `${pipelineId}|${activity.id}|${idx}`
            return (
              <EventRow
                key={idx}
                ev={ev}
                expanded={evExpanded.has(key)}
                onToggle={() => toggleEvent(key)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Event row ────────────────────────────────────────────────────

function EventRow({ ev, expanded, onToggle }: {
  ev: OperationEvent
  expanded: boolean
  onToggle: () => void
}) {
  const hasData = ev.data && Object.keys(ev.data).length > 0
  const isError = !!ev.data["error"]
  const summary = pickEventSummary(ev)
  const label = formatEventLabel(ev)
  return (
    <div>
      <button
        className={`w-full flex items-baseline gap-2 px-2 py-0.5 text-left text-[11px] hover:bg-overlay-2 transition-colors ${
          hasData ? "cursor-pointer" : "cursor-default"
        }`}
        onClick={() => hasData && onToggle()}
      >
        <ChevronRight
          size={9}
          className={`shrink-0 mt-1 text-text-muted/40 transition-transform ${expanded ? "rotate-90" : ""} ${hasData ? "" : "invisible"}`}
        />
        <span className="shrink-0 text-text-muted/50 tabular-nums w-20 font-mono">{fmtTime(ev.timestamp)}</span>
        <span className={`shrink-0 font-mono ${isError ? "text-error" : "text-text-muted/70"}`}>{label}</span>
        {summary && <span className={`min-w-0 break-all ${isError ? "text-error" : "text-text-muted"}`}>{summary}</span>}
      </button>
      {expanded && hasData && (
        <pre className="ml-7 my-1 px-2 py-1.5 bg-base border-l-2 border-border-subtle text-[10.5px] leading-[1.5] text-text-muted/70 whitespace-pre-wrap break-all rounded-r">
          {JSON.stringify(ev.data, null, 2)}
        </pre>
      )}
    </div>
  )
}

// Pull a one-line summary from an event's data payload for inline display.
function pickEventSummary(ev: OperationEvent): string {
  if (ev.type === "sync.execute.step") {
    const step = typeof ev.data["step"] === "string" ? String(ev.data["step"]) : ""
    return EXEC_STEP_DESCRIPTIONS[step] ?? humanizeToken(step)
  }
  if (ev.type === "sync.execute.step.failed") {
    const step = typeof ev.data["step"] === "string" ? String(ev.data["step"]) : "step"
    const error = typeof ev.data["error"] === "string" ? String(ev.data["error"]) : "unknown error"
    return `${humanizeToken(step)} — ${error}`
  }
  if (ev.type === "sync.execute.started") {
    return `${ev.data["source"] ?? "?"} → ${ev.data["target"] ?? "?"}`
  }
  if (ev.type === "sync.execute.completed") {
    const applied = ev.data["applied"]
    if (applied && typeof applied === "object") {
      const counts = applied as Record<string, unknown>
      return `${counts["insert"] ?? 0} ins · ${counts["update"] ?? 0} upd · ${counts["delete"] ?? 0} del`
    }
  }
  if (ev.type === "sync.preview.completed") {
    const totals = ev.data["totals"]
    if (totals && typeof totals === "object") {
      const counts = totals as Record<string, unknown>
      return `${counts["insert"] ?? 0} ins · ${counts["update"] ?? 0} upd · ${counts["delete"] ?? 0} del`
    }
  }
  if (ev.type === "sync.execute.table.start") {
    const table = ev.data["table"] ?? "table"
    const op = ev.data["op"] ?? "apply"
    const rows = ev.data["rowsTotal"]
    return `${table} · ${op}${rows != null ? ` · ${rows} rows` : ""}`
  }
  if (ev.type === "sync.execute.table.done") {
    return `${ev.data["table"] ?? "table"} · ${ev.data["rowsApplied"] ?? "?"} rows applied`
  }
  if (ev.type === "sync.execute.sql") {
    const label = ev.data["label"] ?? "query"
    const rowCount = ev.data["rowCount"] ?? "?"
    const durationMs = ev.data["durationMs"] ?? "?"
    return `${label} · ${rowCount} rows · ${durationMs}ms`
  }
  const d = ev.data
  const parts: string[] = []
  for (const key of ["table", "step", "tool", "label", "sproc", "message", "rowsApplied", "rowCount", "durationMs", "error"]) {
    const v = d[key]
    if (v == null) continue
    if (key === "durationMs" && typeof v === "number") parts.push(`${v}ms`)
    else if (key === "rowsApplied" && typeof v === "number") parts.push(`${v} rows`)
    else if (key === "rowCount" && typeof v === "number") parts.push(`${v} rows`)
    else if (typeof v === "string" || typeof v === "number") parts.push(String(v))
  }
  return parts.slice(0, 4).join(" · ")
}

// `fmtDateTime` exported in case an embedded view wants the long form
export { fmtDateTime }
