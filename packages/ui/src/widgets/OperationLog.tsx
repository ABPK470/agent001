/**
 * Operation Log — audit-oriented view of platform activity (pipelines → steps → events).
 *
 * Data: paginated GET /api/operations (SQLite event_log). SSE only signals refresh.
 */

import { Brain, ChevronRight, Database, FileSearch, Filter, GitCompareArrows, Loader2, Settings, Square, Wrench, X, XCircle } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../api"
import { api, OperationKind, OperationStatus } from "../api"
import { SqlTraceModal } from "../components/SqlTrace"
import { ToolCallModal, ToolIoBlock } from "../components/ToolCallModal"
import { useContainerSize } from "../hooks/useContainerSize"
import { useOperationLogData, type OperationLogKindView } from "../hooks/useOperationLogData"
import { useStore } from "../store"
import { isSyncSqlEventType, readSqlTraceFields } from "../sync-sql-trace"
import {
  buildToolIoFromStepEvents,
  isAgentStepEventType,
  readToolIoFromActivity,
  readToolIoFromEvent,
  stripToolIoForInlineDisplay,
} from "../tool-call-io"
import {
  LOG_TOOLBAR_CHIP,
  LOG_TOOLBAR_CHIP_ACTIVE,
  LOG_TOOLBAR_CHIP_IDLE,
  LOG_TOOLBAR_DIVIDER,
  LOG_TOOLBAR_ICON_BTN,
  LogWidgetToolbar,
  LogWidgetToolbarCount,
  LogWidgetToolbarFilters,
  LogWidgetToolbarSearch,
  LogWidgetToolbarTail,
} from "./widget-toolbar"

// ── Visuals ──────────────────────────────────────────────────────

const KIND_META: Record<
    OperationKind,
    { label: string; Icon: typeof Brain; color: string }
> = {
    "agent-run": { label: "agent", Icon: Brain, color: "var(--color-accent)" },
    "sync-preview": {
        label: "preview",
        Icon: Database,
        color: "var(--color-info)",
    },
    "sync-execute": {
        label: "execute",
        Icon: Database,
        color: "var(--color-success)",
    },
    "sync-run": {
        label: "sync",
        Icon: Database,
        color: "var(--color-info)",
    },
    "proposer-run": {
        label: "scan",
        Icon: GitCompareArrows,
        color: "var(--color-warning)",
    },
    system: {
        label: "system",
        Icon: Settings,
        color: "var(--color-text-muted)",
    },
};

const STATUS_META: Record<OperationStatus, { color: string; tone: string }> = {
  running:   { color: "var(--color-info)", tone: "bg-info-soft text-info" },
  success:   { color: "var(--color-success)", tone: "bg-success-soft text-success" },
  failed:    { color: "var(--color-error)", tone: "bg-error-soft text-error" },
  cancelled: { color: "var(--color-text-muted)", tone: "bg-overlay-2 text-text-muted" },
  skipped:   { color: "var(--color-warning)", tone: "bg-warning-soft text-warning" },
  unknown:   { color: "var(--color-text-muted)", tone: "bg-overlay-2 text-text-muted" },
}

/** Message box in expanded rows — matches the row's terminal status, not always error-red. */
const STATUS_MESSAGE_BOX: Record<OperationStatus, string> = {
  running:   "bg-info-soft border-info/30 text-info",
  success:   "bg-success-soft border-success/30 text-success",
  failed:    "bg-error-soft border-error/30 text-error",
  cancelled: "bg-overlay-2 border-border-subtle text-text-muted",
  skipped:   "bg-warning-soft border-warning/30 text-warning",
  unknown:   "bg-overlay-2 border-border-subtle text-text-muted",
}

const LOG_ROW_ACTION =
  "shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono text-accent hover:text-accent-hover hover:bg-accent/10 rounded transition-colors"

function StatusMessage({ status, children }: { status: OperationStatus; children: ReactNode }) {
  return (
    <div className={`px-2 py-1 mb-1 rounded border text-xs break-all leading-relaxed ${STATUS_MESSAGE_BOX[status]}`}>
      {children}
    </div>
  )
}

function activitySummaryTone(status: OperationStatus): string {
  if (status === "failed") return "text-error"
  if (status === "skipped") return "text-warning"
  if (status === "cancelled") return "text-text-muted"
  return "text-text-muted/70"
}

// system kind is intentionally excluded from the ops log — those events live in the Event Stream widget
const ALL_STATUSES: OperationStatus[] = ["running", "success", "failed", "cancelled", "skipped"]

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
  const activityHay = (activities: OperationActivity[]): string[] =>
    activities.flatMap((a) => [
      a.name,
      a.summary ?? "",
      a.error ?? "",
      ...(a.children?.flatMap((c) => [c.name, c.summary ?? "", c.error ?? ""]) ?? []),
      ...a.events.map((e) => e.type),
    ])

  const hay = [
    p.title, p.subtitle ?? "", p.id, p.error ?? "", p.planId ?? "",
    ...activityHay(p.activities),
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
  auditCheck: "Source audit gate before metadata sync (uspAuditRunCheck).",
  targetLock: "Lock the contract while deployment is in progress.",
  metadataSync: "Apply metadata row changes on the target environment.",
  metadataSyncDone: "Metadata transaction committed successfully.",
  "metadataSync-done": "Metadata transaction committed successfully.",
  pipelineRegister: "Register or refresh the pipeline in the Agent service.",
  contractUndeploy: "Remove previously deployed artifacts marked for replacement.",
  contractUnlockAfterUndeploy: "Release the contract lock after undeploy completes.",
  auditCheckPreDeploy: "Re-run source audit after undeploy, before physical deploy.",
  contractLockForDeploy: "Acquire the deployment lock for the build phase.",
  contractPreScript: "Run pre-deployment SQL scripts.",
  contractCreateDatasetStage: "Create or alter stage datasets.",
  contractCreateDatasetArchive: "Create or alter archive datasets.",
  contractCreateDatasetList: "Create or alter list datasets.",
  contractCreateDatasetDim: "Create or alter dimension datasets.",
  contractCreateDatasetFact: "Create or alter fact datasets.",
  contractCreateFks: "Reconcile foreign keys for deployed datasets.",
  contractDeployEtl: "Create or update ETL procedures, views, and functions.",
  contractDeployRoutine: "Create or update routines and triggers.",
  handleDependencies: "Refresh dependent objects after metadata changes.",
  metaRefresh: "Refresh gate metadata on the target service.",
  pipelineStart: "Trigger the registered pipeline on the target service.",
  setSyncDate: "Stamp the target row sync date.",
  setDeployDate: "Stamp the target row deploy date.",
  syncDate: "Stamp the target row sync date.",
  deployDate: "Stamp the target row deploy date.",
  contractDeploy: "Run the full contract deployment sequence.",
  datasetDeploy: "Trigger dataset deployment in ETL.",
  rulesDeploy: "Trigger rule deployment in ETL.",
}

function activityPipelineKind(pipelineKind: OperationKind, parentPhaseId?: string): OperationKind {
  if (pipelineKind !== OperationKind.SyncRun) return pipelineKind
  if (parentPhaseId === "phase:preview") return OperationKind.SyncPreview
  if (parentPhaseId === "phase:execute") return OperationKind.SyncExecute
  return pipelineKind
}

function formatActivityName(pipelineKind: OperationKind, activity: OperationActivity): string {
  if (pipelineKind === OperationKind.SyncExecute) {
    if (activity.name === "Preflight checks") return activity.name
    if (activity.name === "started") return "Started"
    if (activity.name === "completed") return "Completed"
    if (activity.name === "failed") return "Failed"
    if (activity.name === "phases" || activity.name === "other events" || activity.name.startsWith("tbl:")) return activity.name
    if (activity.name.includes(" (")) return activity.name
    if (activity.name === "skipped" || activity.name === "Execute skipped") return "Execute skipped"
    return humanizeToken(activity.name)
  }
  if (pipelineKind === OperationKind.SyncPreview) {
    if (activity.name === "Preflight checks") return activity.name
    if (activity.name === "started") return "Started"
    if (activity.name === "completed") return "Completed"
    if (activity.name === "failed") return "Failed"
    return activity.name
  }
  if (pipelineKind === OperationKind.AgentRun) {
    if (activity.name === "Sync preview" || activity.name === "Sync execute") return activity.name
    if (activity.name === "queued") return "Queued"
    if (activity.name === "started") return "Started"
    if (activity.name === "completed") return "Completed"
    if (activity.name === "failed") return "Failed"
    if (activity.name === "cancelled") return "Cancelled"
    return humanizeToken(activity.name)
  }
  return activity.name
}

function effectiveActivityStatus(
  activity: OperationActivity,
  pipelineStatus: OperationStatus,
  parentStatus?: OperationStatus
): OperationStatus {
  if (activity.status !== OperationStatus.Running) return activity.status
  const parentTerminal =
    parentStatus === OperationStatus.Failed ||
    parentStatus === OperationStatus.Skipped ||
    parentStatus === OperationStatus.Cancelled
      ? parentStatus
      : null
  const pipelineTerminal =
    pipelineStatus === OperationStatus.Failed ||
    pipelineStatus === OperationStatus.Skipped ||
    pipelineStatus === OperationStatus.Cancelled
      ? pipelineStatus
      : null
  return parentTerminal ?? pipelineTerminal ?? activity.status
}

function defaultActivitySummary(pipelineKind: OperationKind, activity: OperationActivity): string | undefined {
  if (activity.summary) return activity.summary
  if (pipelineKind === OperationKind.SyncExecute) {
    if (activity.status === "skipped") return activity.summary ?? activity.error
    return (
      EXEC_STEP_DESCRIPTIONS[activity.name] ??
      EXEC_STEP_DESCRIPTIONS[activity.name.replace(/-done$/, "Done")] ??
      undefined
    )
  }
  if (pipelineKind === OperationKind.AgentRun) {
    const planId = activity.details?.["planId"]
    if (typeof planId === "string" && activity.name === "Sync preview") {
      return `Delegated preview · plan ${planId.slice(0, 8)}`
    }
    if (typeof planId === "string" && activity.name === "Sync execute") {
      return `Delegated execute · plan ${planId.slice(0, 8)}`
    }
  }
  return undefined
}

/** Expansion key for an activity row — scoped to pipeline id (preview vs execute differ). */
export function pipelineActivityKey(pipelineId: string, activityId: string): string {
  return `${pipelineId}|${activityId}`
}

export function syncPlanIdFromPipeline(pipeline: OperationPipeline): string {
  return pipeline.planId ?? pipeline.id.replace(/:(preview|execute)$/, "")
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
    case "sync.execute.sql":
    case "sync.catalog.sql":
    case "sync.discovery.sql":
    case "sync.preview.sql":
      return "SQL"
    case "sync.execute.archive.probe": return "Archive probe"
    case "sync.execute.archive.probe.batch": return "Archive probe batch"
    case "sync.execute.archive.skipped": return "Archive skipped"
    case "sync.execute.completed": return "Execute complete"
    case "sync.execute.failed": return "Execute failed"
    case "sync.execute.skipped": return "Execute skipped"
    case "sync.proposer.run.started": return "Scan started"
    case "sync.proposer.run.completed": return "Scan completed"
    case "sync.proposer.run.failed": return "Scan failed"
    case "sync.proposer.run.cancelled": return "Scan cancelled"
    case "sync.proposal.created": return "Proposal created"
    case "step.started": return "Tool call"
    case "step.completed": return "Tool result"
    case "step.failed": return "Tool failed"
    default: return ev.type
  }
}

export function OperationLog() {
  const operationLogFocus = useStore((s) => s.operationLogFocus)
  const focusOperationLogPlan = useStore((s) => s.focusOperationLogPlan)
  const focusOperationLogRun = useStore((s) => s.focusOperationLogRun)
  const clearOperationLogFocus = useStore((s) => s.clearOperationLogFocus)

  const [kindView, setKindView] = useState<OperationLogKindView>("all")
  const [statuses, setStatuses] = useState<Set<OperationStatus>>(new Set())
  const [search, setSearch] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [actExpanded, setActExpanded] = useState<Set<string>>(new Set())
  const [evExpanded, setEvExpanded] = useState<Set<string>>(new Set())
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(rootRef)
  const compact = width > 0 && width < 860
  const tiny = width > 0 && width < 480
  const [statusesOpen, setStatusesOpen] = useState(false)
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  const {
    pipelines,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    mode,
    scannedEvents,
    error,
  } = useOperationLogData({ focus: operationLogFocus, kindView, search })

  const expandAuditTree = useCallback((pipeline: OperationPipeline) => {
    setExpanded(new Set([pipeline.id]))
    const actKeys = new Set<string>()
    const walk = (activities: OperationActivity[], phaseId?: string) => {
      for (const activity of activities) {
        const nextPhase = activity.id.startsWith("phase:") ? activity.id : phaseId
        actKeys.add(pipelineActivityKey(pipeline.id, activity.id))
        if (activity.children?.length) walk(activity.children, nextPhase)
      }
    }
    walk(pipeline.activities)
    setActExpanded(actKeys)
  }, [])

  useEffect(() => {
    if (mode !== "focus" || pipelines.length !== 1) return
    expandAuditTree(pipelines[0]!)
  }, [mode, pipelines, expandAuditTree])

  const cancelPipeline = useCallback(async (pipeline: OperationPipeline): Promise<void> => {
    if (pipeline.status !== "running") return
    setCancellingId(pipeline.id)
    try {
      if (pipeline.kind === OperationKind.AgentRun) {
        await api.cancelRun(pipeline.id)
      } else if (pipeline.kind === OperationKind.ProposerRun) {
        await api.cancelProposerRun(pipeline.id)
      }
    } catch {
      /* SSE refresh will reflect final state */
    } finally {
      setCancellingId(null)
    }
  }, [])

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

  const needle = search.trim().toLowerCase()
  const serverSearchActive = needle.length >= 2

  const filtered = useMemo(() => pipelines.filter((p) => {
    if (statuses.size > 0 && !statuses.has(p.status)) return false
    if (!serverSearchActive && needle && !matchesPipeline(p, needle)) return false
    return true
  }), [pipelines, statuses, needle, serverSearchActive])

  const searchPending = serverSearchActive && loading && mode === "list"

  useEffect(() => {
    if (mode === "focus" || !hasMore) return
    const root = scrollRef.current
    const target = sentinelRef.current
    if (!root || !target) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore()
      },
      { root, rootMargin: "240px" },
    )
    obs.observe(target)
    return () => obs.disconnect()
  }, [mode, hasMore, loadMore, filtered.length])

  const emptyMessage = useMemo(() => {
    if (error) return error
    if (mode === "focus" && pipelines.length === 0) {
      return `No operation events found for this ${operationLogFocus?.kind === "plan" ? "plan" : "run"}.`
    }
    if (pipelines.length === 0) return "No operations recorded yet."
    if (statuses.size > 0) return "No operations match the selected statuses."
    if (needle) return "No operations match your search."
    return "No operations recorded yet."
  }, [error, mode, pipelines.length, statuses.size, needle, operationLogFocus?.kind])

  return (
    <div ref={rootRef} className="h-full flex flex-col gap-2.5 overflow-hidden text-text">

      <LogWidgetToolbar compact={compact}>
        <LogWidgetToolbarFilters>
          {(["all", "agent", "sync"] as const).map(v => {
            const active = v === kindView
            const label = v === "sync" ? (compact || tiny ? "sync" : "synchronization") : v
            return (
              <button key={v} onClick={() => setKindView(v)}
                className={`${LOG_TOOLBAR_CHIP} ${active ? LOG_TOOLBAR_CHIP_ACTIVE : LOG_TOOLBAR_CHIP_IDLE}`}
              >{label}</button>
            )
          })}

          {!compact && <div className={LOG_TOOLBAR_DIVIDER} aria-hidden />}

          {!compact ? (
            <>
              {ALL_STATUSES.map(s => {
                const on = statuses.has(s)
                const m  = STATUS_META[s]
                return (
                  <button key={s} onClick={() => toggleStatus(s)}
                    className={`${LOG_TOOLBAR_CHIP} ${on ? `${m.tone} font-medium` : LOG_TOOLBAR_CHIP_IDLE}`}
                  >{s}</button>
                )
              })}
              {statuses.size > 0 && (
                <button onClick={() => setStatuses(new Set())}
                  className={`${LOG_TOOLBAR_ICON_BTN} text-text-muted/60 hover:text-text hover:bg-elevated/40`}
                  title="Clear status filters"
                ><X size={14} /></button>
              )}
            </>
          ) : (
            <div className="relative shrink-0">
              <button
                onClick={() => setStatusesOpen(v => !v)}
                className={`${LOG_TOOLBAR_CHIP} ${
                  statuses.size > 0 ? LOG_TOOLBAR_CHIP_ACTIVE : LOG_TOOLBAR_CHIP_IDLE
                }`}
              >
                <Filter size={13} />
                {statuses.size === 0 ? "status" : `${statuses.size} status`}
              </button>
              {statusesOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setStatusesOpen(false)} />
                  <div className="absolute left-0 top-full mt-1 z-50 bg-elevated border border-border rounded-md shadow-2xl py-1 min-w-[160px]">
                    {ALL_STATUSES.map(s => {
                      const on = statuses.has(s)
                      const m = STATUS_META[s]
                      return (
                        <button
                          key={s}
                          onClick={() => toggleStatus(s)}
                          className={`flex items-center justify-between gap-3 w-full text-left px-3 py-2 text-xs transition-colors ${
                            on ? `${m.tone} font-medium` : "text-text-muted hover:text-text hover:bg-overlay-2"
                          }`}
                        >
                          <span>{s}</span>
                        </button>
                      )
                    })}
                    {statuses.size > 0 && (
                      <button
                        onClick={() => setStatuses(new Set())}
                        className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2 text-xs text-text-muted hover:text-text hover:bg-overlay-2"
                      >
                        <X size={12} />
                        Clear filters
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </LogWidgetToolbarFilters>

        <LogWidgetToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder="Filter operations…"
          loading={searchPending}
          onClear={() => setSearch("")}
        />

        <LogWidgetToolbarTail>
          <LogWidgetToolbarCount filtered={filtered.length} total={pipelines.length} hidden={tiny} />
        </LogWidgetToolbarTail>
      </LogWidgetToolbar>

      {/* ── Body ────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto pr-1">
        {mode === "focus" && operationLogFocus && (
          <div className="mb-3 rounded-md border border-accent/30 bg-accent/5 px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="min-w-0 flex-1">
              <div className="text-xs uppercase tracking-wide text-accent/80">Focused operation</div>
              <div className="text-xs text-text font-mono truncate">
                {operationLogFocus.label ??
                  (operationLogFocus.kind === "plan"
                    ? `plan ${operationLogFocus.id}`
                    : `run ${operationLogFocus.id}`)}
              </div>
              {scannedEvents > 0 && (
                <div className="text-xs text-text-muted/70 tabular-nums">
                  {scannedEvents.toLocaleString()} correlated events
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={clearOperationLogFocus}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs text-text-muted hover:text-text hover:bg-overlay-2 rounded transition-colors"
            >
              <X size={12} />
              Back to list
            </button>
          </div>
        )}

        {loading && filtered.length === 0 && (
          <div className="text-text-muted/60 text-xs text-center py-8 flex items-center justify-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            Loading operations…
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-text-muted text-center pt-12 text-sm">{emptyMessage}</div>
        )}

        {filtered.length > 0 && (
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
            onOpenSyncPlan={(planId) => focusOperationLogPlan(planId)}
            onFocusAgentRun={(runId, label) => focusOperationLogRun(runId, label)}
            onCancelPipeline={cancelPipeline}
            cancellingId={cancellingId}
          />
        )}

        {mode === "list" && hasMore && (
          <div ref={sentinelRef} className="py-6 flex justify-center">
            {loadingMore && (
              <span className="text-xs text-text-muted/60 flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" />
                Loading more…
              </span>
            )}
          </div>
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
  onFocusAgentRun,
  onCancelPipeline,
  cancellingId,
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
  onFocusAgentRun?: (runId: string, label?: string) => void
  onCancelPipeline?: (pipeline: OperationPipeline) => void
  cancellingId?: string | null
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
            className="sticky top-0 z-10 w-full flex items-center gap-1.5 px-2 py-1 mb-1 text-xs uppercase tracking-wider text-text-muted/50 bg-surface/80 backdrop-blur-sm hover:text-text-muted/80 transition-colors text-left"
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
                  onFocusAgentRun={onFocusAgentRun}
                  onCancel={onCancelPipeline}
                  cancelling={cancellingId === p.id}
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

function PipelineRow({ pipeline, expanded, onToggle, actExpanded, toggleActivity, evExpanded, toggleEvent, compact, onOpenSyncPlan, onFocusAgentRun, onCancel, cancelling }: {
  pipeline: OperationPipeline
  expanded: boolean
  onToggle: () => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
  compact: boolean
  onOpenSyncPlan?: (planId: string) => void
  onFocusAgentRun?: (runId: string, label?: string) => void
  onCancel?: (pipeline: OperationPipeline) => void
  cancelling?: boolean
}) {
  const km = KIND_META[pipeline.kind]
  const sm = STATUS_META[pipeline.status]
  const Icon = km.Icon
  const canCancel =
    pipeline.status === "running" &&
    onCancel &&
    (pipeline.kind === OperationKind.AgentRun || pipeline.kind === OperationKind.ProposerRun)
  const showRunAudit = pipeline.kind === OperationKind.AgentRun && onFocusAgentRun
  const syncPlanId =
    onOpenSyncPlan &&
    (pipeline.kind === OperationKind.SyncPreview ||
      pipeline.kind === OperationKind.SyncExecute ||
      pipeline.kind === OperationKind.SyncRun)
      ? syncPlanIdFromPipeline(pipeline)
      : null

  return (
    <div className="rounded-md border border-border-subtle bg-overlay-1 overflow-hidden">
      <div className="flex items-center gap-1 pr-1">
      <button
        className="min-w-0 flex-1 flex items-center gap-2 px-3 py-2 hover:bg-overlay-2 transition-colors text-left"
        onClick={onToggle}
      >
        <ChevronRight size={14} className={`shrink-0 text-text-muted/60 transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Icon size={14} className="shrink-0" style={{ color: km.color }} />
        <span className={`shrink-0 text-xs uppercase tracking-wide px-1.5 py-0.5 rounded ${sm.tone}`}>
          {pipeline.status === "running" && <Loader2 size={9} className="inline mr-0.5 animate-spin" />}
          {pipeline.status}
        </span>
        <span className="min-w-0 truncate text-xs text-text">{pipeline.title}</span>

        {pipeline.subtitle && !compact && (
          <span className="shrink-0 text-xs text-text-muted/60 font-mono truncate max-w-[14rem]">{pipeline.subtitle}</span>
        )}
        <div className="flex-1 min-w-0" />
        <span className="shrink-0 text-xs text-text-muted/60 tabular-nums">
          {pipeline.activityCount} act · {pipeline.eventCount} ev
        </span>
        <span className="shrink-0 text-xs text-text-muted tabular-nums w-16 text-right">{fmtDuration(pipeline.durationMs)}</span>
        <span className="shrink-0 text-xs text-text-muted/50 tabular-nums w-20 text-right">{fmtTime(pipeline.startedAt)}</span>
      </button>
      {showRunAudit && (
        <button
          type="button"
          title="Open full run audit"
          className={LOG_ROW_ACTION}
          onClick={() => onFocusAgentRun!(pipeline.id, pipeline.title)}
        >
          <FileSearch size={10} />
          Audit
        </button>
      )}
      {syncPlanId && (
        <button
          type="button"
          title="Open full sync audit"
          className={LOG_ROW_ACTION}
          onClick={() => onOpenSyncPlan!(syncPlanId)}
        >
          <FileSearch size={10} />
          Audit
        </button>
      )}
      {canCancel && (
        <button
          type="button"
          title="Stop"
          disabled={cancelling}
          onClick={() => onCancel(pipeline)}
          className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md border border-border-subtle text-text-muted transition-colors hover:bg-error/10 hover:text-error hover:border-error/30 disabled:opacity-40"
        >
          {cancelling ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />}
        </button>
      )}
      </div>

      {expanded && (
        <div className="border-t border-border-subtle bg-base/40 px-2 py-1.5 space-y-0.5">
          {pipeline.error && (
            <div className="px-2.5">
              <StatusMessage status={pipeline.status}>{pipeline.error}</StatusMessage>
            </div>
          )}
          {pipeline.activities.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-text-muted/60">No activities recorded.</div>
          )}
          {pipeline.activities.map((a) => {
            const key = pipelineActivityKey(pipeline.id, a.id)
            return (
              <ActivityRow
                key={key}
                activity={a}
                pipelineKind={pipeline.kind}
                pipelineId={pipeline.id}
                pipelineStatus={pipeline.status}
                onOpenSyncPlan={onOpenSyncPlan}
                expanded={actExpanded.has(key)}
                onToggle={() => toggleActivity(key)}
                actExpanded={actExpanded}
                toggleActivity={toggleActivity}
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

function ActivityRow({ activity, pipelineKind, pipelineId, pipelineStatus, parentStatus, parentPhaseId, depth = 0, expanded, onToggle, actExpanded, toggleActivity, evExpanded, toggleEvent, onOpenSyncPlan }: {
  activity: OperationActivity
  pipelineKind: OperationKind
  pipelineId: string
  pipelineStatus: OperationStatus
  parentStatus?: OperationStatus
  parentPhaseId?: string
  depth?: number
  expanded: boolean
  onToggle: () => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
  onOpenSyncPlan?: (planId: string) => void
}) {
  const [ioModalOpen, setIoModalOpen] = useState(false)
  const phaseId = activity.id.startsWith("phase:") ? activity.id : parentPhaseId
  const effectiveKind = activityPipelineKind(pipelineKind, phaseId)
  const status = effectiveActivityStatus(activity, pipelineStatus, parentStatus)
  const sm = STATUS_META[status]
  const StatusIcon = status === "failed" ? XCircle
    : status === "running" ? Loader2 : null
  const renderedName = formatActivityName(effectiveKind, activity)
  const renderedSummary = defaultActivitySummary(effectiveKind, activity)
  const hasChildren = (activity.children?.length ?? 0) > 0
  const statusMessage = activity.error ?? (
    (status === "failed" || status === "skipped" || status === "cancelled") && activity.summary
      ? activity.summary
      : null
  )
  const toolIo =
    readToolIoFromActivity(activity) ??
    (activity.events.length > 0 ? buildToolIoFromStepEvents(activity.events) : null)
  const delegationPlanId =
    typeof activity.details?.["planId"] === "string" ? activity.details["planId"] : null

  return (
    <div className="rounded border border-border-subtle" style={depth > 0 ? { marginLeft: depth * 12 } : undefined}>
      <button
        className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-overlay-2 transition-colors text-left"
        onClick={onToggle}
      >
        <ChevronRight size={12} className={`shrink-0 text-text-muted/60 transition-transform ${expanded ? "rotate-90" : ""}`} />
        {StatusIcon && (
          <StatusIcon
            size={11}
            className={`shrink-0 ${status === "running" ? "animate-spin" : ""}`}
            style={{ color: sm.color }}
          />
        )}
        {!StatusIcon && <span className="w-[11px] h-[11px] rounded-full shrink-0" style={{ background: sm.color, opacity: 0.6 }} />}
        <span className="min-w-0 truncate text-xs text-text font-mono">{renderedName}</span>
        {renderedSummary && !statusMessage && (
          <span className={`shrink-0 text-xs truncate max-w-[18rem] ${activitySummaryTone(status)}`}>
            {renderedSummary}
          </span>
        )}
        <div className="flex-1 min-w-0" />
        {activity.events.length > 0 && (
          <span className="shrink-0 text-xs text-text-muted/60 tabular-nums">{activity.events.length} ev</span>
        )}
        <span className="shrink-0 text-xs text-text-muted tabular-nums w-14 text-right">{fmtDuration(activity.durationMs)}</span>
        <span className="shrink-0 text-xs text-text-muted/50 tabular-nums w-20 text-right">{fmtTime(activity.startedAt)}</span>
        {delegationPlanId && onOpenSyncPlan && (
          <button
            type="button"
            title="Open sync audit"
            className={LOG_ROW_ACTION}
            onClick={(e) => {
              e.stopPropagation()
              onOpenSyncPlan(delegationPlanId)
            }}
          >
            <FileSearch size={10} />
            Audit
          </button>
        )}
        {toolIo && (
          <button
            type="button"
            className={LOG_ROW_ACTION}
            onClick={(e) => {
              e.stopPropagation()
              setIoModalOpen(true)
            }}
          >
            <Wrench size={10} />
            I/O
          </button>
        )}
      </button>

      {ioModalOpen && toolIo && (
        <ToolCallModal io={toolIo} onClose={() => setIoModalOpen(false)} />
      )}

      {expanded && (
        <div className="border-t border-border-subtle px-2.5 py-1.5 space-y-0.5 bg-base/30">
          {statusMessage && (
            <StatusMessage status={status}>{statusMessage}</StatusMessage>
          )}
          {activity.events.length === 0 && (activity.summary || activity.details) && !statusMessage && (
            <div className="px-2 py-1.5 space-y-1.5">
              {activity.summary && (
                <p className="text-xs text-text-muted leading-relaxed">{activity.summary}</p>
              )}
              {toolIo && !activity.events.length && (
                <ToolIoBlock io={toolIo} compact maxHeight={120} />
              )}
              {activity.details && Object.keys(activity.details).length > 0 && !toolIo && (
                <pre className="px-2 py-1.5 bg-base border-l-2 border-border-subtle text-xs leading-[1.5] text-text-muted/70 whitespace-pre-wrap break-all rounded-r">
                  {JSON.stringify(activity.details, null, 2)}
                </pre>
              )}
            </div>
          )}
          {hasChildren && activity.children!.map((child) => {
            const childKey = pipelineActivityKey(pipelineId, child.id)
            return (
              <ActivityRow
                key={childKey}
                activity={child}
                pipelineKind={pipelineKind}
                pipelineId={pipelineId}
                pipelineStatus={pipelineStatus}
                parentStatus={status}
                parentPhaseId={phaseId}
                depth={(depth ?? 0) + 1}
                expanded={actExpanded.has(childKey)}
                onToggle={() => toggleActivity(childKey)}
                actExpanded={actExpanded}
                toggleActivity={toggleActivity}
                evExpanded={evExpanded}
                toggleEvent={toggleEvent}
                onOpenSyncPlan={onOpenSyncPlan}
              />
            )
          })}
          {activity.events.length > 0 && toolIo && (
            <div className="px-2 py-1">
              <ToolIoBlock io={toolIo} compact maxHeight={100} />
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
  const [sqlModalOpen, setSqlModalOpen] = useState(false)
  const [ioModalOpen, setIoModalOpen] = useState(false)
  const hasData = ev.data && Object.keys(ev.data).length > 0
  const isFailedEvent = ev.type.includes(".failed") || !!ev.data["error"]
  const isSkippedEvent = ev.type.includes(".skipped")
  const isSql = isSyncSqlEventType(ev.type)
  const isStep = isAgentStepEventType(ev.type)
  const sqlFields = isSql ? readSqlTraceFields(ev.data) : null
  const toolIo = isStep ? readToolIoFromEvent(ev) : null
  const summary = pickEventSummary(ev)
  const label = formatEventLabel(ev)
  const displayData = isSql
    ? stripSqlPayloadForDisplay(ev.type, ev.data)
    : isStep
      ? stripToolIoForInlineDisplay(ev.data)
      : ev.data

  return (
    <div>
      <div className="flex items-baseline gap-1 pr-1">
        <button
          className={`min-w-0 flex-1 flex items-baseline gap-2 px-2 py-0.5 text-left text-xs hover:bg-overlay-2 transition-colors ${
            hasData ? "cursor-pointer" : "cursor-default"
          }`}
          onClick={() => hasData && onToggle()}
        >
          <ChevronRight
            size={9}
            className={`shrink-0 mt-1 text-text-muted/40 transition-transform ${expanded ? "rotate-90" : ""} ${hasData ? "" : "invisible"}`}
          />
          <span className="shrink-0 text-text-muted/50 tabular-nums w-20 font-mono">{fmtTime(ev.timestamp)}</span>
          <span className={`shrink-0 font-mono ${
            isFailedEvent ? "text-error" : isSkippedEvent ? "text-warning" : "text-text-muted/70"
          }`}>{label}</span>
          {summary && (
            <span className={`min-w-0 break-all ${
              isFailedEvent ? "text-error" : isSkippedEvent ? "text-warning" : "text-text-muted"
            }`}>{summary}</span>
          )}
        </button>
        {isSql && sqlFields && (
          <button
            type="button"
            className={LOG_ROW_ACTION}
            onClick={() => setSqlModalOpen(true)}
          >
            <Database size={10} />
            SQL
          </button>
        )}
        {isStep && toolIo && (
          <button
            type="button"
            className={LOG_ROW_ACTION}
            onClick={() => setIoModalOpen(true)}
          >
            <Wrench size={10} />
            I/O
          </button>
        )}
      </div>
      {expanded && hasData && (
        <div className="ml-7 my-1">
          <pre className="px-2 py-1.5 bg-base border-l-2 border-border-subtle text-xs leading-[1.5] text-text-muted/70 whitespace-pre-wrap break-all rounded-r">
            {JSON.stringify(displayData, null, 2)}
          </pre>
        </div>
      )}
      {sqlModalOpen && sqlFields && (
        <SqlTraceModal fields={sqlFields} onClose={() => setSqlModalOpen(false)} />
      )}
      {ioModalOpen && toolIo && (
        <ToolCallModal io={toolIo} onClose={() => setIoModalOpen(false)} />
      )}
    </div>
  )
}

function stripSqlPayloadForDisplay(type: string, data: Record<string, unknown>): Record<string, unknown> {
  if (!isSyncSqlEventType(type)) return data
  const { sql: _sql, __fullSql: _full, ...rest } = data
  return rest
}

// Pull a one-line summary from an event's data payload for inline display.
function pickEventSummary(ev: OperationEvent): string {
  if (ev.type === "step.started") {
    const toolIo = readToolIoFromEvent(ev)
    return toolIo?.argsSummary ?? resolveInlineToolName(ev.data)
  }
  if (ev.type === "step.completed") {
    const toolIo = readToolIoFromEvent(ev)
    const dur = ev.data["durationMs"]
    const durPart = typeof dur === "number" ? `${dur}ms` : null
    const outPart = toolIo?.outputText ? truncateInline(toolIo.outputText, 100) : null
    return [outPart, durPart].filter(Boolean).join(" · ") || "completed"
  }
  if (ev.type === "step.failed") {
    const err = typeof ev.data["error"] === "string" ? ev.data["error"] : "step failed"
    return truncateInline(err, 120)
  }
  if (ev.type === "sync.execute.step") {
    const step = typeof ev.data["step"] === "string" ? String(ev.data["step"]) : ""
    return EXEC_STEP_DESCRIPTIONS[step] ?? humanizeToken(step)
  }
  if (ev.type === "sync.execute.step.failed") {
    const step = typeof ev.data["step"] === "string" ? String(ev.data["step"]) : "step"
    const op = typeof ev.data["op"] === "string" ? String(ev.data["op"]) : null
    const table = typeof ev.data["table"] === "string" ? String(ev.data["table"]) : null
    const error = typeof ev.data["cause"] === "string"
      ? String(ev.data["cause"])
      : typeof ev.data["error"] === "string"
        ? String(ev.data["error"])
        : "unknown error"
    return [humanizeToken(step), op, table, error].filter(Boolean).join(" — ")
  }
  if (ev.type === "sync.execute.skipped") {
    const step = typeof ev.data["step"] === "string" ? humanizeToken(String(ev.data["step"])) : null
    const message = typeof ev.data["message"] === "string" ? String(ev.data["message"]) : null
    return [step, message].filter(Boolean).join(" — ") || "Skipped"
  }
  if (ev.type === "sync.execute.failed") {
    const step = typeof ev.data["step"] === "string" ? humanizeToken(String(ev.data["step"])) : null
    const op = typeof ev.data["op"] === "string" ? String(ev.data["op"]) : null
    const table = typeof ev.data["table"] === "string" ? String(ev.data["table"]) : null
    const error = typeof ev.data["cause"] === "string"
      ? String(ev.data["cause"])
      : typeof ev.data["error"] === "string"
        ? String(ev.data["error"])
        : "unknown error"
    return [step, op, table, error].filter(Boolean).join(" — ")
  }
  if (ev.type === "sync.execute.started") {
    return `${ev.data["source"] ?? "?"} → ${ev.data["target"] ?? "?"}`
  }
  if (ev.type === "sync.execute.completed") {
    const applied = ev.data["applied"]
    if (applied && typeof applied === "object") {
      const counts = applied as Record<string, unknown>
      const base = `${counts["insert"] ?? 0} ins · ${counts["update"] ?? 0} upd · ${counts["delete"] ?? 0} del`
      const warnings = ev.data["warnings"]
      if (Array.isArray(warnings) && warnings.length > 0) {
        return `${base} · ${warnings.length} deploy failure(s)`
      }
      return base
    }
  }
  if (ev.type === "sync.preview.started") {
    return `${ev.data["source"] ?? "?"} → ${ev.data["target"] ?? "?"}`
  }
  if (ev.type === "sync.preview.completed") {
    const totals = ev.data["totals"]
    if (totals && typeof totals === "object") {
      const counts = totals as Record<string, unknown>
      return `${counts["insert"] ?? 0} ins · ${counts["update"] ?? 0} upd · ${counts["delete"] ?? 0} del`
    }
  }
  if (ev.type === "sync.preview.table.done") {
    const counts =
      ev.data["counts"] && typeof ev.data["counts"] === "object"
        ? (ev.data["counts"] as Record<string, unknown>)
        : ev.data
    const ins = counts["insert"] ?? 0
    const upd = counts["update"] ?? 0
    const del = counts["delete"] ?? 0
    const table = ev.data["table"] ?? "table"
    const durationMs = ev.data["durationMs"]
    return `${table} · ${ins} ins · ${upd} upd · ${del} del${typeof durationMs === "number" ? ` · ${durationMs}ms` : ""}`
  }
  if (ev.type === "sync.preview.table.start") {
    const table = ev.data["table"] ?? "table"
    const predicate = ev.data["predicate"]
    return predicate && typeof predicate === "string" ? `${table} · ${predicate}` : String(table)
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
  if (ev.type.endsWith(".sql") && ev.type.startsWith("sync.")) {
    const label = ev.data["label"] ?? "query"
    const rowCount = ev.data["rowCount"] ?? "?"
    const durationMs = ev.data["durationMs"] ?? "?"
    const connection = ev.data["connection"]
    const scope = ev.data["scope"]
    return [
      scope ? `${label} (${scope})` : label,
      connection,
      `${rowCount} rows`,
      `${durationMs}ms`,
    ].filter(Boolean).join(" · ")
  }
  const d = ev.data
  const parts: string[] = []
  for (const key of ["table", "step", "op", "tool", "label", "sproc", "message", "rowsApplied", "rowCount", "durationMs", "cause", "error"]) {
    const v = d[key]
    if (v == null) continue
    if (key === "durationMs" && typeof v === "number") parts.push(`${v}ms`)
    else if (key === "rowsApplied" && typeof v === "number") parts.push(`${v} rows`)
    else if (key === "rowCount" && typeof v === "number") parts.push(`${v} rows`)
    else if (typeof v === "string" || typeof v === "number") parts.push(String(v))
  }
  return parts.slice(0, 4).join(" · ")
}

function resolveInlineToolName(data: Record<string, unknown>): string {
  const action = data["action"]
  if (typeof action === "string" && action.length > 0) return action
  const tool = data["tool"]
  if (typeof tool === "string" && tool.length > 0) return tool
  return "step"
}

function truncateInline(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  return t.slice(0, max - 1) + "…"
}

// `fmtDateTime` exported in case an embedded view wants the long form
export { fmtDateTime }
