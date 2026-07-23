/**
 * Operation Log — audit-oriented view of platform activity (pipelines → steps → events).
 *
 * Data: paginated GET /api/operations (SQLite event_log). SSE only signals refresh.
 */

import { describeDebugTracePayload, eventLabel } from "@mia/shared-types"
import { Brain, ChevronRight, Database, GitCompareArrows, Loader2, Settings, Shuffle, Square, Wrench } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../client/index"
import { api, OperationKind, OperationStatus } from "../client/index"
import { CodeBlock } from "../components/CodeBlock"
import { DecisionLogPanel, isSyncDecisionLogDetails } from "./pipelines/DecisionLogPanel"
import { EmptyState } from "../components/EmptyState"
import { JsonViewer } from "../components/JsonViewer"
import { ToolIoBlock } from "./chat/ToolCallModal"
import { useContainerSize } from "../hooks/useContainerSize"
import { useOperationLogData, type OperationLogKindView } from "../hooks/useOperationLogData"
import {
  OperationLogModalsProvider,
  useOpLogOpenSqlTrace,
  useOpLogOpenToolIo,
} from "./pipelines/operation-log-modals"
import { WIDGET_ICONS } from "./widget-icons"
import {
  fmtDuration,
  fmtTime,
  formatPipelineSubtitle,
  LogGroup,
  LogNest,
  LogStatusLabel,
  OP_LOG,
  OP_LOG_MONO,
  OP_LOG_MUTED,
  OP_LOG_DESC,
  OpLogRow,
} from "./pipelines/operation-log-row"
import {
  describeSqlEvent,
  describeSqlOnlyActivity,
  formatTraceRowSummary,
} from "./pipelines/operation-log-trace"
import { isSyncSqlEventType, hasSqlTraceContent, readSqlTraceFields } from "./sync/trace/sync-sql-trace"
import {
  formatHttpTraceSummary,
  isSyncHttpEventType,
  readHttpTraceFields,
} from "./sync/trace/sync-http-trace"
import {
  coerceToolIoFromActivity,
  isAgentStepEventType,
  readToolIoFromEvent,
  stripToolIoForInlineDisplay,
} from "./chat/tool-call-io"
import { OperationLogToolbar } from "./operation-log-toolbar"

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
    "bridge-preview": {
        label: "bridge",
        Icon: Shuffle,
        color: "var(--color-accent)",
    },
    "bridge-run": {
        label: "bridge",
        Icon: Shuffle,
        color: "var(--color-accent)",
    },
    system: {
        label: "system",
        Icon: Settings,
        color: "var(--color-text-muted)",
    },
};

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
  "shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-sm font-mono text-accent hover:text-accent-hover hover:bg-accent/10 rounded transition-colors"

function StatusMessage({ status, children }: { status: OperationStatus; children: ReactNode }) {
  return (
    <div className={`px-2 py-1 mb-1 rounded border break-all ${OP_LOG} ${STATUS_MESSAGE_BOX[status]}`}>
      {children}
    </div>
  )
}

function isDuplicatePipelineMessage(pipelineError: string | undefined, text: string | undefined): boolean {
  if (!pipelineError || !text) return false
  return pipelineError === text
}

// ── Helpers ──────────────────────────────────────────────────────

const JSON_DISPLAY_MAX_CHARS = 48_000

function safeJsonForDisplay(value: unknown, maxChars = JSON_DISPLAY_MAX_CHARS): string {
  try {
    const text = JSON.stringify(value, null, 2)
    if (text.length <= maxChars) return text
    const omitted = text.length - maxChars
    return `${text.slice(0, maxChars)}\n\n/* … ${omitted.toLocaleString()} more chars */`
  } catch {
    return "[could not serialize result data]"
  }
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

export function matchesPipeline(p: OperationPipeline, needle: string): boolean {
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
    if (activity.name === "result") return "Result"
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
  if (activity.name === "result") return undefined
  // Skipped flow steps: show the skip reason from the result child, not the generic step blurb.
  if (activity.status === "skipped") {
    const resultChild = activity.children?.find((c) => c.name === "result")
    if (resultChild?.summary) return resultChild.summary
    if (activity.error) return activity.error
  }
  if (activity.summary && activity.status !== "skipped") return activity.summary
  if (pipelineKind === OperationKind.SyncExecute) {
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

function isSyncExecuteFlowStep(kind: OperationKind, activity: OperationActivity): boolean {
  if (kind !== OperationKind.SyncExecute) return false
  if (activity.id.startsWith("lifecycle:")) return false
  if (activity.name.startsWith("tbl:")) return false
  return !["started", "completed", "failed", "Preflight checks", "skipped", "result", "Execute skipped"].includes(activity.name)
}

function shouldHideSyncExecuteStepEvent(kind: OperationKind, activity: OperationActivity, ev: OperationEvent): boolean {
  return isSyncExecuteFlowStep(kind, activity) && ev.type === "sync.execute.step"
}

function isSqlOnlyActivity(activity: OperationActivity): boolean {
  return (
    activity.name.startsWith("SQL · ") &&
    activity.events.length === 1 &&
    isSyncSqlEventType(activity.events[0]!.type) &&
    (activity.children?.length ?? 0) === 0
  )
}

/** Expansion key for an activity row — scoped to pipeline id (preview vs execute differ). */
export function pipelineActivityKey(pipelineId: string, activityId: string): string {
  return `${pipelineId}|${activityId}`
}

export function syncPlanIdFromPipeline(pipeline: OperationPipeline): string {
  return pipeline.planId ?? pipeline.id.replace(/:(preview|execute)$/, "")
}

// ── Debug trace (agent telemetry) — labels from event catalog ─────

function describeDebugTraceEntry(ev: OperationEvent): { label: string; summary: string } {
  return describeDebugTracePayload((ev.data ?? {}) as Record<string, unknown>)
}

function formatEventLabel(ev: OperationEvent): string {
  if (ev.type === "debug.trace") return describeDebugTraceEntry(ev).label
  // Prefer shared catalog for known SSE types; keep OpLog switch for sync chrome.
  const fromCatalog = eventLabel(ev.type)
  if (
    fromCatalog &&
    fromCatalog !== "Event" &&
    !ev.type.startsWith("sync.") &&
    !ev.type.startsWith("bridge.")
  ) {
    return fromCatalog
  }
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
    case "sync.execute.http":
      return "HTTP"
    case "sync.execute.archive.probe": return "Archive probe"
    case "sync.execute.archive.probe.batch": return "Archive probe batch"
    case "sync.execute.archive.skipped": return "Archive skipped"
    case "sync.execute.completed": return "Execute complete"
    case "sync.execute.failed": return "Execute failed"
    case "sync.execute.cancelled": return "Execute cancelled"
    case "sync.execute.skipped": return "Execute skipped"
    case "sync.proposer.run.started": return "Scan started"
    case "sync.proposer.run.completed": return "Scan completed"
    case "sync.proposer.run.failed": return "Scan failed"
    case "sync.proposer.run.cancelled": return "Scan cancelled"
    case "sync.proposal.created": return "Proposal created"
    case "bridge.preview.started": return "Preview started"
    case "bridge.preview.completed": return "Preview complete"
    case "bridge.preview.failed": return "Preview failed"
    case "bridge.run.started": return "Move started"
    case "bridge.run.progress": return "Progress"
    case "bridge.run.completed": return "Move complete"
    case "bridge.run.failed": return "Move failed"
    case "step.started": return "Tool call"
    case "step.completed": return "Tool result"
    case "step.failed": return "Tool failed"
    default: return ev.type
  }
}

export function OperationLog() {
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
    error,
  } = useOperationLogData({ kindView, search })

  const cancelPipeline = useCallback(async (pipeline: OperationPipeline): Promise<void> => {
    if (pipeline.status !== "running") return
    setCancellingId(pipeline.id)
    try {
      if (pipeline.kind === OperationKind.AgentRun) {
        await api.cancelRun(pipeline.id)
      } else if (pipeline.kind === OperationKind.ProposerRun) {
        await api.cancelProposerRun(pipeline.id)
      } else if (
        pipeline.kind === OperationKind.SyncRun ||
        pipeline.kind === OperationKind.SyncExecute
      ) {
        await api.cancelSyncExecute(syncPlanIdFromPipeline(pipeline))
      }
    } catch (err: unknown) { console.error("[mia]", err) } finally {
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

  const searchPending = serverSearchActive && loading

  useEffect(() => {
    if (!hasMore) return
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
  }, [hasMore, loadMore, filtered.length])

  const emptyMessage = useMemo(() => {
    if (error) return error
    if (pipelines.length === 0) return "No operations recorded yet."
    if (statuses.size > 0) return "No operations match the selected statuses."
    if (needle) return "No operations match your search."
    return "No operations recorded yet."
  }, [error, pipelines.length, statuses.size, needle])

  return (
    <OperationLogModalsProvider>
    <div ref={rootRef} className={`flex h-full min-h-0 flex-1 flex-col gap-2.5 overflow-hidden ${OP_LOG}`}>

      <OperationLogToolbar
        kindView={kindView}
        setKindView={setKindView}
        statuses={statuses}
        toggleStatus={toggleStatus}
        clearStatuses={() => setStatuses(new Set())}
        search={search}
        setSearch={setSearch}
        searchPending={searchPending}
        compact={compact}
        tiny={tiny}
        statusesOpen={statusesOpen}
        setStatusesOpen={setStatusesOpen}
        filteredCount={filtered.length}
        totalCount={pipelines.length}
      />

      {/* ── Body — bottom padding keeps the last card off the widget lip ─ */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1 pb-4">
        {loading && filtered.length === 0 && (
          <div className="flex flex-1 items-center justify-center gap-2 text-center text-sm text-text-muted/60">
            <Loader2 size={14} className="animate-spin" />
            Loading operations…
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <EmptyState icon={WIDGET_ICONS["operation-log"]} message={emptyMessage} />
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
            onCancelPipeline={cancelPipeline}
            cancellingId={cancellingId}
          />
        )}

        {hasMore && (
          <div ref={sentinelRef} className="py-6 flex justify-center">
            {loadingMore && (
              <span className="text-sm text-text-muted/60 flex items-center gap-2">
                <Loader2 size={12} className="animate-spin" />
                Loading more…
              </span>
            )}
          </div>
        )}
      </div>
    </div>
    </OperationLogModalsProvider>
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
  onCancelPipeline,
  cancellingId,
  linear = false,
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
  onCancelPipeline?: (pipeline: OperationPipeline) => void
  cancellingId?: string | null
  linear?: boolean
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
        <div key={group.label} className={linear ? "mb-4" : "mb-3"}>
          <button
            className={`sticky top-0 z-10 w-full flex items-center gap-1.5 px-2 py-1 mb-1 text-left ${
              linear
                ? "text-sm font-medium uppercase tracking-wider text-text-muted bg-surface/95 backdrop-blur-sm"
                : "text-sm uppercase tracking-wider text-text-muted/50 bg-surface/80 backdrop-blur-sm hover:text-text-muted/80"
            } transition-colors`}
            onClick={() => toggleDay(group.label)}
          >
            <ChevronRight size={10} className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
            {group.label}
            <span className="ml-1 text-text-muted/30 normal-case tracking-normal">{group.items.length}</span>
          </button>
          {!collapsed && (
            <div className={linear ? "space-y-0" : "space-y-1"}>
              {group.items.map(p => (
                <PipelineRow
                  key={p.id}
                  linear={linear}
                  pipeline={p}
                  expanded={expanded.has(p.id)}
                  onToggle={() => togglePipeline(p.id)}
                  actExpanded={actExpanded}
                  toggleActivity={toggleActivity}
                  evExpanded={evExpanded}
                  toggleEvent={toggleEvent}
                  compact={compact}
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

function PipelineRow({ pipeline, expanded, onToggle, actExpanded, toggleActivity, evExpanded, toggleEvent, compact, onCancel, cancelling, linear }: {
  pipeline: OperationPipeline
  expanded: boolean
  onToggle: () => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
  compact: boolean
  onCancel?: (pipeline: OperationPipeline) => void
  cancelling?: boolean
  linear?: boolean
}) {
  const km = KIND_META[pipeline.kind]
  const Icon = km.Icon
  const canCancel =
    pipeline.status === "running" &&
    onCancel &&
    (pipeline.kind === OperationKind.AgentRun ||
      pipeline.kind === OperationKind.ProposerRun ||
      pipeline.kind === OperationKind.SyncRun ||
      pipeline.kind === OperationKind.SyncExecute)
  const formattedSubtitle = pipeline.subtitle
    ? formatPipelineSubtitle(pipeline.subtitle)
    : null

  if (linear) {
    return (
      <div className="border-b border-border-subtle last:border-b-0">
        <div className="flex items-center gap-1 pr-1">
          <button
            type="button"
            className="min-w-0 flex-1 flex items-center gap-2.5 px-3 py-2 hover:bg-elevated/50 transition-colors text-left"
            onClick={onToggle}
          >
            <ChevronRight
              size={14}
              className={`shrink-0 text-text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
            />
            <Icon size={15} className="shrink-0" style={{ color: km.color }} />
            <LogStatusLabel status={pipeline.status} />
            <span className={`min-w-0 flex-1 truncate ${OP_LOG} ${OP_LOG_MUTED}`}>
              <span className="font-medium">{pipeline.title}</span>
              {formattedSubtitle && !compact && (
                <span className={`${OP_LOG_MONO} font-normal ${OP_LOG_DESC}`}> · {formattedSubtitle}</span>
              )}
            </span>
            <span className={`shrink-0 tabular-nums ${OP_LOG} ${OP_LOG_MUTED}`}>
              {fmtDuration(pipeline.durationMs)}
            </span>
            <span className={`shrink-0 tabular-nums ${OP_LOG} w-[4.5rem] text-right ${OP_LOG_MUTED}`}>
              {fmtTime(pipeline.startedAt)}
            </span>
          </button>
          {canCancel && (
            <button
              type="button"
              title="Stop"
              disabled={cancelling}
              onClick={() => onCancel!(pipeline)}
              className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-error/10 hover:text-error disabled:opacity-40"
            >
              {cancelling ? <Loader2 size={13} className="animate-spin" /> : <Square size={12} />}
            </button>
          )}
        </div>
        {expanded && (
          <LogNest linear>
            {pipeline.error && (
              <div className="px-3 py-2">
                <StatusMessage status={pipeline.status}>{pipeline.error}</StatusMessage>
              </div>
            )}
            {pipeline.activities.length === 0 && (
              <div className="px-3 py-2 text-sm text-text-muted">No activities recorded.</div>
            )}
            {pipeline.activities.map((a, idx) => {
              const key = pipelineActivityKey(pipeline.id, a.id)
              return (
                <ActivityRow
                  key={key}
                  linear
                  isLast={idx === pipeline.activities.length - 1}
                  activity={a}
                  pipelineKind={pipeline.kind}
                  pipelineId={pipeline.id}
                  pipelineStatus={pipeline.status}
                  pipelineError={pipeline.error}
                  expanded={actExpanded.has(key)}
                  onToggle={() => toggleActivity(key)}
                  actExpanded={actExpanded}
                  toggleActivity={toggleActivity}
                  evExpanded={evExpanded}
                  toggleEvent={toggleEvent}
                />
              )
            })}
          </LogNest>
        )}
      </div>
    )
  }

  return (
    <LogGroup>
      <div className="flex items-center gap-1 pr-1">
      <button
        className="min-w-0 flex-1 flex items-center gap-2 px-3 py-2 hover:bg-overlay-2/80 transition-colors text-left"
        onClick={onToggle}
      >
        <ChevronRight size={14} className={`shrink-0 text-text-muted transition-transform ${expanded ? "rotate-90" : ""}`} />
        <Icon size={14} className="shrink-0" style={{ color: km.color }} />
        <LogStatusLabel status={pipeline.status} />
        <span className={`min-w-0 flex-1 ${OP_LOG} ${OP_LOG_MUTED}`}>
          <span className="font-medium">{pipeline.title}</span>
          {formattedSubtitle && !compact && (
            <span className={`${OP_LOG_MONO} font-normal ${OP_LOG_DESC}`}> · {formattedSubtitle}</span>
          )}
        </span>
        <span className={`shrink-0 tabular-nums ${OP_LOG} ${OP_LOG_MUTED}`}>
          {pipeline.activityCount} act · {pipeline.eventCount} ev
        </span>
        <span className={`shrink-0 tabular-nums w-16 text-right ${OP_LOG} ${OP_LOG_MUTED}`}>{fmtDuration(pipeline.durationMs)}</span>
        <span className={`shrink-0 tabular-nums w-[4.5rem] text-right ${OP_LOG} ${OP_LOG_MUTED}`}>{fmtTime(pipeline.startedAt)}</span>
      </button>
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
        <LogNest root>
          {pipeline.error && (
            <div className="px-2.5 py-1.5">
              <StatusMessage status={pipeline.status}>{pipeline.error}</StatusMessage>
            </div>
          )}
          {pipeline.activities.length === 0 && (
            <div className="px-2.5 py-2 text-sm text-text-muted">No activities recorded.</div>
          )}
          {pipeline.activities.map((a, idx) => {
            const key = pipelineActivityKey(pipeline.id, a.id)
            return (
              <ActivityRow
                key={key}
                isLast={idx === pipeline.activities.length - 1}
                activity={a}
                pipelineKind={pipeline.kind}
                pipelineId={pipeline.id}
                pipelineStatus={pipeline.status}
                pipelineError={pipeline.error}
                expanded={actExpanded.has(key)}
                onToggle={() => toggleActivity(key)}
                actExpanded={actExpanded}
                toggleActivity={toggleActivity}
                evExpanded={evExpanded}
                toggleEvent={toggleEvent}
              />
            )
          })}
        </LogNest>
      )}
    </LogGroup>
  )
}

// ── SQL-only activity (one line + modal, no expand) ──────────────

function SqlOnlyActivityRow({
  activity,
  status,
  linear,
  isLast,
  depth = 0,
}: {
  activity: OperationActivity
  status: OperationStatus
  linear?: boolean
  isLast?: boolean
  depth?: number
}) {
  const openSqlTrace = useOpLogOpenSqlTrace()
  const trace = describeSqlOnlyActivity(activity)

  return (
    <OpLogRow
      linear={linear}
      isLast={isLast}
      depth={depth}
      status={status}
      showChevron={false}
      label={
        <span className={`${OP_LOG_MONO} ${OP_LOG_MUTED}`}>
          {formatTraceRowSummary(trace)}
        </span>
      }
      durationMs={activity.durationMs}
      timestamp={activity.startedAt}
      actions={
        trace.sqlFields ? (
          <button
            type="button"
            className={LOG_ROW_ACTION}
            onClick={(e) => {
              e.stopPropagation()
              openSqlTrace(trace.sqlFields!)
            }}
          >
            <Database size={10} />
            {trace.detailLabel}
          </button>
        ) : undefined
      }
    />
  )
}

// ── Flow-step SQL row (expand → result JSON; SQL icon → modal) ───

function FlowStepSqlRow({
  ev,
  resultData,
  expanded,
  onToggle,
  linear,
  isLast,
  depth = 0,
}: {
  ev: OperationEvent
  resultData?: Record<string, unknown>
  expanded: boolean
  onToggle: () => void
  linear?: boolean
  isLast?: boolean
  depth?: number
}) {
  const openSqlTrace = useOpLogOpenSqlTrace()
  const trace = describeSqlEvent(ev)
  const expandable = resultData != null && Object.keys(resultData).length > 0
  const resultJson = useMemo(
    () => (expanded && resultData ? safeJsonForDisplay(resultData) : null),
    [expanded, resultData],
  )

  return (
    <OpLogRow
      linear={linear}
      isLast={isLast && !expanded}
      depth={depth}
      expanded={expanded}
      expandable={expandable}
      onToggle={onToggle}
      showStatus={false}
      label={<span className={OP_LOG_MUTED}>{formatTraceRowSummary(trace)}</span>}
      durationMs={trace.durationMs}
      timestamp={ev.timestamp}
      actions={
        trace.sqlFields ? (
          <button
            type="button"
            className={LOG_ROW_ACTION}
            onClick={(e) => {
              e.stopPropagation()
              openSqlTrace(trace.sqlFields!)
            }}
          >
            <Database size={10} />
            {trace.detailLabel}
          </button>
        ) : undefined
      }
    >
      {resultJson && (
        <div className={`px-3 py-2 ${linear ? "bg-elevated/30" : "bg-base/30 border-t border-border-subtle"}`}>
          <CodeBlock code={resultJson} lang="json" maxHeight={480} />
        </div>
      )}
    </OpLogRow>
  )
}

/** HTTP peer of FlowStepSqlRow — method/path summary; expand → request/response JSON. */
function FlowStepHttpRow({
  ev,
  expanded,
  onToggle,
  linear,
  isLast,
  depth = 0,
}: {
  ev: OperationEvent
  expanded: boolean
  onToggle: () => void
  linear?: boolean
  isLast?: boolean
  depth?: number
}) {
  const fields = readHttpTraceFields(ev.data)
  const failed = Boolean(fields?.error) || (fields != null && fields.status >= 400)
  const summary = fields ? formatHttpTraceSummary(fields) : "HTTP"
  const detail = {
    method: fields?.method,
    url: fields?.url,
    status: fields?.status,
    durationMs: fields?.durationMs,
    requestBody: fields?.requestBody ?? null,
    responseBody: fields?.responseBody ?? null,
    ...(fields?.error ? { error: fields.error } : {}),
  }

  return (
    <OpLogRow
      linear={linear}
      isLast={isLast && !expanded}
      depth={depth}
      expanded={expanded}
      expandable
      onToggle={onToggle}
      showStatus
      status={failed ? OperationStatus.Failed : OperationStatus.Success}
      label={<span className={`${OP_LOG_MONO} ${OP_LOG_MUTED}`}>HTTP</span>}
      meta={summary}
      durationMs={fields?.durationMs ?? null}
      timestamp={ev.timestamp}
    >
      {expanded && (
        <div className={`px-2.5 py-1.5 ${linear ? "bg-elevated/30" : "bg-base/30 border-t border-border-subtle"}`}>
          <JsonViewer value={detail} label="http" defaultExpandDepth={2} maxHeight={360} />
        </div>
      )}
    </OpLogRow>
  )
}

// ── Activity row ─────────────────────────────────────────────────

function ActivityRow({ activity, pipelineKind, pipelineId, pipelineStatus, pipelineError, parentStatus, parentPhaseId, depth = 0, expanded, onToggle, actExpanded, toggleActivity, evExpanded, toggleEvent, linear, isLast }: {
  activity: OperationActivity
  pipelineKind: OperationKind
  pipelineId: string
  pipelineStatus: OperationStatus
  pipelineError?: string
  parentStatus?: OperationStatus
  parentPhaseId?: string
  depth?: number
  expanded: boolean
  onToggle: () => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
  linear?: boolean
  isLast?: boolean
}) {
  const openToolIo = useOpLogOpenToolIo()
  const phaseId = activity.id.startsWith("phase:") ? activity.id : parentPhaseId
  const effectiveKind = activityPipelineKind(pipelineKind, phaseId)
  const status = effectiveActivityStatus(activity, pipelineStatus, parentStatus)
  const renderedName = formatActivityName(effectiveKind, activity)
  const isResultRow = activity.name === "result"
  const isFlowStep = isSyncExecuteFlowStep(effectiveKind, activity)
  const resultChild = activity.children?.find((c) => c.name === "result")
  const hasChildren = (activity.children?.length ?? 0) > 0
  const sqlEvents = activity.events.filter((ev) => isSyncSqlEventType(ev.type))
  const httpEvents = activity.events.filter((ev) => isSyncHttpEventType(ev.type))
  const toolIo = coerceToolIoFromActivity(activity)
  const renderedSummary =
    defaultActivitySummary(effectiveKind, activity) ??
    toolIo?.argsSummary ??
    (toolIo?.status === "failed" ? toolIo.error : undefined)
  // Agent tool rows: I/O is first-class (button + ToolIoBlock). Nested step.* /
  // tool_call.* EventRows only repeat that payload with input/output stripped —
  // hide them so every tool reads as clearly as ask_user.
  const isAgentToolStep =
    effectiveKind === OperationKind.AgentRun && toolIo != null && !isFlowStep && !isResultRow
  const visibleEvents = activity.events.filter((ev) => {
    if (isSyncSqlEventType(ev.type) || isSyncHttpEventType(ev.type)) return false
    if (shouldHideSyncExecuteStepEvent(effectiveKind, activity, ev)) return false
    if (isAgentToolStep) {
      if (isAgentStepEventType(ev.type)) return false
      if (ev.type.startsWith("tool_call.")) return false
    }
    return true
  })
  const statusMessage =
    isResultRow || resultChild != null ? null : activity.error ?? null

  if (isSqlOnlyActivity(activity)) {
    return (
      <SqlOnlyActivityRow
        activity={activity}
        status={status}
        linear={linear}
        isLast={isLast}
        depth={depth}
      />
    )
  }

  const detailEventCount = sqlEvents.length + httpEvents.length + visibleEvents.length
  const hasExpandedContent =
    expanded &&
    (statusMessage ||
      isFlowStep ||
      isResultRow ||
      hasChildren ||
      (isAgentToolStep && toolIo != null) ||
      detailEventCount > 0 ||
      (!isResultRow && !isAgentToolStep && activity.events.length > 0) ||
      (!isResultRow && activity.events.length === 0 && activity.details))

  const trailingAfterSql = hasChildren || httpEvents.length > 0 || visibleEvents.length > 0
  const trailingAfterHttp = hasChildren || visibleEvents.length > 0

  const rowActions = toolIo ? (
    <button
      type="button"
      className={LOG_ROW_ACTION}
      onClick={(e) => {
        e.stopPropagation()
        openToolIo(toolIo)
      }}
    >
      <Wrench size={10} />
      I/O
    </button>
  ) : undefined

  const rowBody = (
    <>
      <OpLogRow
        linear={linear}
        // Depth 0: collapsed rows rely on the panel’s divide-y; when expanded,
        // draw a rule under the activity so the first child isn’t flush to it.
        isLast={
          depth === 0 && !linear
            ? !hasExpandedContent
            : isLast && !hasExpandedContent
        }
        depth={depth}
        status={status}
        expanded={expanded}
        expandable
        onToggle={onToggle}
        label={<span className={`${OP_LOG_MONO} ${OP_LOG_MUTED}`}>{renderedName}</span>}
        meta={renderedSummary && !isResultRow ? renderedSummary : undefined}
        durationMs={activity.durationMs}
        timestamp={activity.startedAt}
        actions={rowActions}
      />
      {expanded && (
        <LogNest linear={linear}>
          {statusMessage && !isDuplicatePipelineMessage(pipelineError, statusMessage) && (
            <div className="px-2.5 py-1.5">
              <StatusMessage status={status}>{statusMessage}</StatusMessage>
            </div>
          )}
          {isFlowStep && sqlEvents.map((ev, idx) => {
            const key = `${pipelineId}|${activity.id}|sql:${idx}`
            const resultData = resultChild?.events[0]?.data as Record<string, unknown> | undefined
            return (
              <FlowStepSqlRow
                key={key}
                linear={linear}
                depth={depth + 1}
                isLast={idx === sqlEvents.length - 1 && !trailingAfterSql}
                ev={ev}
                resultData={resultData}
                expanded={evExpanded.has(key)}
                onToggle={() => toggleEvent(key)}
              />
            )
          })}
          {isFlowStep && httpEvents.map((ev, idx) => {
            const key = `${pipelineId}|${activity.id}|http:${idx}`
            return (
              <FlowStepHttpRow
                key={key}
                linear={linear}
                depth={depth + 1}
                isLast={idx === httpEvents.length - 1 && !trailingAfterHttp}
                ev={ev}
                expanded={evExpanded.has(key)}
                onToggle={() => toggleEvent(key)}
              />
            )
          })}
          {isResultRow && activity.events[0] && (
            <div className="px-2.5 py-1.5">
              <CodeBlock
                code={safeJsonForDisplay(activity.events[0].data)}
                lang="json"
                maxHeight={480}
              />
            </div>
          )}
          {isAgentToolStep && toolIo && (
            <div className="px-2.5 py-1.5">
              <ToolIoBlock io={toolIo} compact maxHeight={320} />
            </div>
          )}
          {!isResultRow && !isAgentToolStep && activity.events.length === 0 && activity.details && !statusMessage && (
            <div className="px-0 py-0">
              {toolIo && (
                <div className="px-2.5 py-1.5">
                  <ToolIoBlock io={toolIo} compact maxHeight={280} />
                </div>
              )}
              {activity.details && Object.keys(activity.details).length > 0 && !toolIo && (
                isSyncDecisionLogDetails(activity.details) ? (
                  <DecisionLogPanel decisions={activity.details.decisions} linear={linear} depth={depth + 1} />
                ) : (
                  <div className="px-2.5 py-1.5">
                    <JsonViewer value={activity.details} label="details" defaultExpandDepth={2} maxHeight={280} />
                  </div>
                )
              )}
            </div>
          )}
          {hasChildren && !isResultRow && activity.children!.map((child, idx) => {
            const childKey = pipelineActivityKey(pipelineId, child.id)
            return (
              <ActivityRow
                key={childKey}
                linear={linear}
                isLast={idx === activity.children!.length - 1 && visibleEvents.length === 0}
                activity={child}
                pipelineKind={pipelineKind}
                pipelineId={pipelineId}
                pipelineStatus={pipelineStatus}
                pipelineError={pipelineError}
                parentStatus={status}
                parentPhaseId={phaseId}
                depth={(depth ?? 0) + 1}
                expanded={actExpanded.has(childKey)}
                onToggle={() => toggleActivity(childKey)}
                actExpanded={actExpanded}
                toggleActivity={toggleActivity}
                evExpanded={evExpanded}
                toggleEvent={toggleEvent}
              />
            )
          })}
          {!isResultRow && !isFlowStep && !isAgentToolStep && visibleEvents.map((ev, idx) => {
            const key = `${pipelineId}|${activity.id}|${idx}`
            return (
              <EventRow
                key={key}
                linear={linear}
                depth={depth + 1}
                isLast={idx === visibleEvents.length - 1}
                ev={ev}
                expanded={evExpanded.has(key)}
                onToggle={() => toggleEvent(key)}
              />
            )
          })}
          {isFlowStep && visibleEvents.map((ev, idx) => {
            const key = `${pipelineId}|${activity.id}|misc:${idx}`
            return (
              <EventRow
                key={key}
                linear={linear}
                depth={depth + 1}
                isLast={idx === visibleEvents.length - 1}
                ev={ev}
                expanded={evExpanded.has(key)}
                onToggle={() => toggleEvent(key)}
              />
            )
          })}
        </LogNest>
      )}
    </>
  )

  // Depth-0 activities live inside LogNest’s inset panel (divide-y) — one wrapper
  // per activity so header + nested events stay a single divide unit (no card chrome).
  if (depth === 0 && !linear) {
    return <div className="min-w-0 last:pb-0.5">{rowBody}</div>
  }

  return rowBody
}

// ── Event row ────────────────────────────────────────────────────

function EventRow({ ev, expanded, onToggle, linear, isLast, depth = 0 }: {
  ev: OperationEvent
  expanded: boolean
  onToggle: () => void
  linear?: boolean
  isLast?: boolean
  depth?: number
}) {
  const openSqlTrace = useOpLogOpenSqlTrace()
  const openToolIo = useOpLogOpenToolIo()
  const hasData = ev.data && Object.keys(ev.data).length > 0
  const isFailedEvent = ev.type.includes(".failed") || !!ev.data["error"]
  const isSkippedEvent = ev.type.includes(".skipped")
  const isSql = isSyncSqlEventType(ev.type)
  const isHttp = isSyncHttpEventType(ev.type)
  const isStep = isAgentStepEventType(ev.type)
  const sqlFields = isSql ? readSqlTraceFields(ev.data) : null
  const sqlTrace = isSql ? describeSqlEvent(ev) : null
  const httpFields = isHttp ? readHttpTraceFields(ev.data) : null
  const toolIo = isStep ? readToolIoFromEvent(ev) : null
  const summary = isSql && sqlTrace
    ? formatTraceRowSummary(sqlTrace)
    : isHttp && httpFields
      ? formatHttpTraceSummary(httpFields)
      : pickEventSummary(ev)
  const label = isSql ? null : formatEventLabel(ev)
  const displayData = isStep
    ? stripToolIoForInlineDisplay(ev.data)
    : ev.data
  const durationMs = typeof ev.data["durationMs"] === "number" ? ev.data["durationMs"] : null
  const evStatus: OperationStatus = isFailedEvent
    ? OperationStatus.Failed
    : isSkippedEvent
      ? OperationStatus.Skipped
      : OperationStatus.Success

  return (
    <>
      <OpLogRow
        linear={linear}
        isLast={isLast && !expanded}
        depth={depth}
        expanded={expanded}
        expandable={hasData && !isSql}
        onToggle={onToggle}
        showStatus
        status={evStatus}
        label={
          label ? (
            <span className={`${OP_LOG_MONO} ${OP_LOG_MUTED}`}>{label}</span>
          ) : (
            <span className={OP_LOG_MUTED}>{summary}</span>
          )
        }
        meta={label && summary ? summary : undefined}
        durationMs={durationMs}
        timestamp={ev.timestamp}
        actions={
          <>
            {isSql && sqlFields && hasSqlTraceContent(sqlFields) && (
              <button
                type="button"
                className={LOG_ROW_ACTION}
                onClick={(e) => {
                  e.stopPropagation()
                  openSqlTrace(sqlFields)
                }}
              >
                <Database size={10} />
                SQL
              </button>
            )}
            {isStep && toolIo && (
              <button
                type="button"
                className={LOG_ROW_ACTION}
                onClick={(e) => {
                  e.stopPropagation()
                  openToolIo(toolIo)
                }}
              >
                <Wrench size={10} />
                I/O
              </button>
            )}
          </>
        }
      >
        {hasData && !isSql && (
          <div className={`px-2.5 py-1.5 ${linear ? "bg-elevated/30" : "bg-base/30 border-t border-border-subtle"}`}>
            <JsonViewer value={displayData} label="event" defaultExpandDepth={3} maxHeight={360} />
          </div>
        )}
      </OpLogRow>
    </>
  )
}

// Pull a one-line summary from an event's data payload for inline display.
function pickEventSummary(ev: OperationEvent): string {
  if (ev.type === "debug.trace") return describeDebugTraceEntry(ev).summary
  if (ev.type === "step.started") {
    const toolIo = readToolIoFromEvent(ev)
    return toolIo?.argsSummary ?? resolveInlineToolName(ev.data)
  }
  if (ev.type === "step.completed") {
    const toolIo = readToolIoFromEvent(ev)
    const dur = ev.data["durationMs"]
    const durPart = typeof dur === "number" ? `${dur}ms` : null
    const outPart = toolIo?.outputText ?? null
    return [outPart, durPart].filter(Boolean).join(" · ") || "completed"
  }
  if (ev.type === "step.failed") {
    const err = typeof ev.data["error"] === "string" ? ev.data["error"] : "step failed"
    return err
  }
  if (ev.type === "sync.execute.step") {
    return ""
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
  if (ev.type === "bridge.preview.started" || ev.type === "bridge.run.started") {
    const source = ev.data["source"]
    const target = ev.data["target"]
    const sourceSpec = ev.data["sourceSpec"]
    const targetSpec = ev.data["targetSpec"]
    const route =
      target != null ? `${source ?? "?"} → ${target}` : String(source ?? "?")
    const specs =
      typeof sourceSpec === "string" && typeof targetSpec === "string"
        ? `${sourceSpec} → ${targetSpec}`
        : typeof sourceSpec === "string"
          ? sourceSpec
          : typeof targetSpec === "string"
            ? targetSpec
            : null
    return [route, specs].filter(Boolean).join(" · ")
  }
  if (ev.type === "bridge.run.progress") {
    const rowsRead = ev.data["rowsRead"]
    const rowsWritten = ev.data["rowsWritten"]
    const elapsedMs = ev.data["elapsedMs"]
    return [
      rowsRead != null || rowsWritten != null
        ? `read ${rowsRead ?? "?"} · wrote ${rowsWritten ?? "?"}`
        : null,
      typeof elapsedMs === "number" ? `${elapsedMs}ms` : null,
    ]
      .filter(Boolean)
      .join(" · ")
  }
  if (
    ev.type === "bridge.preview.completed" ||
    ev.type === "bridge.run.completed" ||
    ev.type === "bridge.preview.failed" ||
    ev.type === "bridge.run.failed"
  ) {
    const parts: string[] = []
    if (ev.data["rowCount"] != null) parts.push(`${ev.data["rowCount"]} rows`)
    if (ev.data["rowsRead"] != null || ev.data["rowsWritten"] != null) {
      parts.push(`read ${ev.data["rowsRead"] ?? "?"} · wrote ${ev.data["rowsWritten"] ?? "?"}`)
    }
    if (typeof ev.data["errorCount"] === "number" && ev.data["errorCount"] > 0) {
      parts.push(`${ev.data["errorCount"]} error(s)`)
    }
    if (typeof ev.data["error"] === "string") parts.push(ev.data["error"])
    if (typeof ev.data["durationMs"] === "number") parts.push(`${ev.data["durationMs"]}ms`)
    if (ev.data["truncated"] === true) parts.push("truncated")
    return parts.join(" · ")
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
    const sql = typeof ev.data["sql"] === "string" ? ev.data["sql"].trim() : ""
    if (sql) return sql
    const rowCount = ev.data["rowCount"]
    const durationMs = ev.data["durationMs"]
    const connection = ev.data["connection"]
    return [
      connection != null ? String(connection) : null,
      rowCount != null ? `${rowCount} rows` : null,
      durationMs != null ? `${durationMs}ms` : null,
    ].filter(Boolean).join(" · ") || "SQL"
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

export { fmtDateTime } from "./pipelines/operation-log-row"
