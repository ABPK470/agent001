/**
 * Operation Log — audit-oriented view of platform activity (pipelines → steps → events).
 *
 * Data: paginated GET /api/operations (SQLite event_log). SSE only signals refresh.
 */

import { describeDebugTracePayload, eventLabel } from "@mia/shared-types"
import { Brain, ChevronRight, Database, Globe, Loader2, Square, Wrench } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../client/index"
import { api, OperationKind, OperationStatus } from "../client/index"
import { VirtualList } from "../components/VirtualList"
import { DecisionLogPanel, isSyncDecisionLogDetails } from "./pipelines/DecisionLogPanel"
import { EmptyState } from "../components/EmptyState"
import { JsonViewer } from "../components/JsonViewer"
import { ReviewTreeItem } from "../components/ReviewTree"
import { ToolIoBlock } from "./chat/ToolCallModal"
import { useWidgetInstance } from "../app/workspace/widget-instance"
import { useContainerSize } from "../hooks/useContainerSize"
import { useOperationLogData, type OperationLogKindView } from "../hooks/useOperationLogData"
import {
  readOperationLogPrefs,
  writeOperationLogPrefs,
  type PipelineKindFilter,
} from "../lib/operation-log-prefs"
import type { EventStreamRange, EventStreamWindow } from "../lib/event-stream-prefs"
import { flattenOperationRows } from "../lib/operation-flat-rows"
import {
  OperationLogModalsProvider,
  useOpLogOpenSqlTrace,
  useOpLogOpenToolIo,
} from "./pipelines/operation-log-modals"
import { WIDGET_ICONS } from "./widget-icons"
import {
  formatPipelineSubtitle,
  LogGroup,
  LogNest,
  OP_LOG,
  OP_LOG_MONO,
  OP_LOG_MUTED,
  OP_LOG_DESC,
  OpLogRow,
  OpLogTreeHeader,
  OpLogErrorTreeRow,
  OpLogNestedBlock,
  opLogRowChromeClass,
  PipelineRowCells,
  opLogShowStatusPill,
} from "./pipelines/operation-log-row"
import { pipelineEntityIcon } from "./pipelines/op-log-entity-icon"
import {
  WIDGET_LOG_BODY_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
} from "./widget-toolbar"
import { OperationLogToolbar } from "./operation-log-toolbar"
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
import {
  beginSplitPaneDrag,
  endSplitPaneDrag,
  moveSplitPaneDrag,
  type SplitPaneDragState,
} from "../lib/split-pane-drag"
import { OperationLogInspector } from "./pipelines/OperationLogInspector"
import {
  OperationLogActivityTreeRow,
  opLogActivityTreeRowHeight,
} from "./pipelines/OperationLogActivityTreeRow"
import { OperationLogPipelineListRow, opLogPipelineListRowHeight } from "./pipelines/OperationLogPipelineListRow"
import type { OpLogSelection } from "./pipelines/OperationLogScopeDetail"

const OP_LOG_SPLIT_MIN = 0.28
const OP_LOG_SPLIT_MAX = 0.62
const OP_LOG_SPLIT_DEFAULT = 0.4
const OP_LOG_LIST_ROW_HEIGHT = 44

// ── Visuals ──────────────────────────────────────────────────────

const LOG_ROW_ACTION =
  "shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-sm font-mono text-accent hover:text-accent-hover hover:bg-accent/10 rounded transition-colors"

function isDuplicatePipelineMessage(pipelineError: string | undefined, text: string | undefined): boolean {
  if (!pipelineError || !text) return false
  return pipelineError === text
}

const LIFECYCLE_ACTIVITY_NAMES = new Set([
  "started",
  "completed",
  "failed",
  "cancelled",
  "queued",
])

/** Hide event rows already folded into the parent activity row label/meta. */
function isRedundantActivityEvent(activity: OperationActivity, ev: OperationEvent): boolean {
  if (
    LIFECYCLE_ACTIVITY_NAMES.has(activity.name) &&
    activity.events.length === 1 &&
    activity.events[0] === ev
  ) {
    return true
  }
  if (activity.id.startsWith("tbl:") || activity.id.startsWith("etbl:")) {
    if (ev.type.endsWith(".table.start") || ev.type.endsWith(".table.done")) return true
  }
  return false
}

/** Flow steps with table children already represent table work — skip mirror events. */
function filterFlowStepVisibleEvents(
  effectiveKind: OperationKind,
  activity: OperationActivity,
  events: OperationEvent[],
): OperationEvent[] {
  if (!isSyncExecuteFlowStep(effectiveKind, activity)) return events
  if ((activity.children?.length ?? 0) === 0) return events
  return events.filter(
    (ev) => !ev.type.endsWith(".table.start") && !ev.type.endsWith(".table.done"),
  )
}

function eventRowExpandable(ev: OperationEvent): boolean {
  if (isSyncSqlEventType(ev.type)) return false
  if (!ev.data || Object.keys(ev.data).length === 0) return false
  if (
    ev.type.endsWith(".table.start") ||
    ev.type.endsWith(".table.done") ||
    ev.type === "sync.execute.step" ||
    ev.type === "sync.preview.started" ||
    ev.type === "sync.execute.started" ||
    ev.type === "sync.preview.completed" ||
    ev.type === "sync.execute.completed" ||
    ev.type === "sync.preview.failed" ||
    ev.type === "sync.execute.failed"
  ) {
    return false
  }
  if (isAgentStepEventType(ev.type)) {
    return Object.keys(stripToolIoForInlineDisplay(ev.data)).length > 0
  }
  return true
}

function countActivityNestableRows(opts: {
  inlineError: string | null
  isFlowStep: boolean
  isResultRow: boolean
  isAgentToolStep: boolean
  hasChildren: boolean
  sqlEvents: OperationEvent[]
  httpEvents: OperationEvent[]
  visibleEvents: OperationEvent[]
  activity: OperationActivity
  toolIo: ReturnType<typeof coerceToolIoFromActivity> | null
}): number {
  let count = 0
  if (opts.inlineError) count++
  if (opts.isFlowStep) count += opts.sqlEvents.length + opts.httpEvents.length
  if (opts.isResultRow && opts.activity.events[0]) count++
  if (opts.isAgentToolStep && opts.toolIo) count++
  if (
    !opts.isResultRow &&
    !opts.isAgentToolStep &&
    opts.activity.events.length === 0 &&
    opts.activity.details
  ) {
    if (opts.toolIo) count++
    else if (Object.keys(opts.activity.details).length > 0) count++
  }
  if (opts.hasChildren && !opts.isResultRow) {
    count += opts.activity.children!.length
  }
  if (!opts.isResultRow && !opts.isAgentToolStep) {
    count += opts.visibleEvents.length
  }
  return count
}

function activityRowSummary(
  effectiveKind: OperationKind,
  activity: OperationActivity,
  opts: {
    expanded: boolean
    toolIo: ReturnType<typeof coerceToolIoFromActivity> | null
    isAgentToolStep: boolean
  },
): string | undefined {
  if (opts.toolIo && (opts.expanded || opts.isAgentToolStep)) return undefined
  return (
    defaultActivitySummary(effectiveKind, activity) ??
    (!opts.expanded ? opts.toolIo?.argsSummary : undefined) ??
    (opts.toolIo?.status === "failed" ? opts.toolIo.error : undefined)
  )
}

// ── Helpers ──────────────────────────────────────────────────────

/** Sticky day caps — quieter type + shared `--section-cap-bg` seal. */
const DAY_GROUP_BTN =
  "review-group-label review-group-cap sticky top-0 z-10 w-full flex items-center gap-1.5 py-1 text-left transition-colors"
const DAY_GROUP_BTN_LINEAR = DAY_GROUP_BTN
const DAY_GROUP_BTN_NESTED =
  `${DAY_GROUP_BTN} text-text-muted/50 hover:text-text-muted/80`

/**
 * Day-cap row wrap. Virtual rows are absolute — margin on a prior pipeline
 * does not open air before the next day. Put group separation as padding-top
 * on every day after the first; keep a short pad under the cap before items.
 */
function dayGroupWrapClass(isFirst: boolean): string {
  return isFirst ? "pb-1" : "pt-3.5 pb-1"
}

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

/** Expansion key — hierarchical path so duplicate activity ids (e.g. preflight) stay unique. */
export function pipelineActivityKey(
  pipelineId: string,
  activityId: string,
  parentKey?: string,
): string {
  if (parentKey) return `${parentKey}/${activityId}`
  return `${pipelineId}|${activityId}`
}

export function pipelineEventKey(activityKey: string, suffix: string): string {
  return `${activityKey}|${suffix}`
}

export function syncPlanIdFromPipeline(pipeline: OperationPipeline): string {
  return pipeline.planId ?? pipeline.id.replace(/:(preview|execute)$/, "")
}

/** Bridge pipeline id is `${moveId}:preview|run`. */
export function bridgeMoveIdFromPipeline(pipeline: OperationPipeline): string {
  return pipeline.id.replace(/:(preview|run)$/, "")
}

// ── Debug trace (agent telemetry) — labels from event catalog ─────

function describeDebugTraceEntry(ev: OperationEvent): { label: string; summary: string } {
  return describeDebugTracePayload((ev.data ?? {}) as Record<string, unknown>)
}

function formatEventLabel(ev: OperationEvent): string {
  if (ev.type === "debug.trace") return describeDebugTraceEntry(ev).label
  const fromCatalog = eventLabel(ev.type)
  if (fromCatalog && fromCatalog !== "Event") return fromCatalog
  return ev.type
}

function pipelineMatchesKinds(
  pipeline: OperationPipeline,
  kinds: Set<PipelineKindFilter>,
): boolean {
  if (kinds.size === 0) return true
  if (kinds.has("agent") && pipeline.kind === OperationKind.AgentRun) return true
  if (
    kinds.has("sync") &&
    (pipeline.kind === OperationKind.SyncRun ||
      pipeline.kind === OperationKind.SyncPreview ||
      pipeline.kind === OperationKind.SyncExecute ||
      pipeline.kind === OperationKind.ProposerRun)
  ) {
    return true
  }
  if (
    kinds.has("bridge") &&
    (pipeline.kind === OperationKind.BridgePreview ||
      pipeline.kind === OperationKind.BridgeRun)
  ) {
    return true
  }
  return false
}

function kindViewFromKinds(kinds: Set<PipelineKindFilter>): OperationLogKindView {
  if (kinds.size === 1) {
    const only = [...kinds][0]
    if (only) return only
  }
  return "all"
}

export function OperationLog() {
  const instance = useWidgetInstance()
  const tileId = instance?.widgetId ?? null
  const initialPrefs = useMemo(() => readOperationLogPrefs(tileId), [tileId])

  const [kinds, setKinds] = useState<Set<PipelineKindFilter>>(
    () => new Set(initialPrefs.kinds),
  )
  const [statuses, setStatuses] = useState<Set<OperationStatus>>(
    () => new Set(initialPrefs.statuses),
  )
  const [search, setSearch] = useState(() => initialPrefs.searchText)
  const [timeWindow, setTimeWindow] = useState<EventStreamWindow>(
    () => initialPrefs.window,
  )
  const [selection, setSelection] = useState<OpLogSelection | null>(null)
  const [openPipelineIds, setOpenPipelineIds] = useState<Set<string>>(new Set())
  const [actExpanded, setActExpanded] = useState<Set<string>>(new Set())
  const [collapsedDays, setCollapsedDays] = useState<Set<string>>(new Set())
  const [splitRatio, setSplitRatio] = useState(OP_LOG_SPLIT_DEFAULT)
  const rootRef = useRef<HTMLDivElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const splitShellRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef<SplitPaneDragState | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { width } = useContainerSize(rootRef)
  const tiny = width > 0 && width < 480
  const [cancellingId, setCancellingId] = useState<string | null>(null)

  useEffect(() => {
    writeOperationLogPrefs(tileId, {
      kinds: [...kinds],
      statuses: [...statuses],
      searchText: search,
      window: timeWindow,
    })
  }, [tileId, kinds, statuses, search, timeWindow])

  const setQuickRange = useCallback((range: EventStreamRange) => {
    setTimeWindow({ range, from: undefined, to: undefined })
  }, [])
  const setFromDate = useCallback((from: string | undefined) => {
    setTimeWindow((prev) => ({ ...prev, from: from || undefined }))
  }, [])
  const setToDate = useCallback((to: string | undefined) => {
    setTimeWindow((prev) => ({ ...prev, to: to || undefined }))
  }, [])

  const kindView = kindViewFromKinds(kinds)
  const {
    pipelines,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    error,
  } = useOperationLogData({ kindView, search, window: timeWindow })

  const cancelPipeline = useCallback(async (pipeline: OperationPipeline): Promise<void> => {
    if (pipeline.status !== "running") return
    setCancellingId(pipeline.id)
    try {
      if (pipeline.kind === OperationKind.AgentRun) {
        await api.cancelRun(pipeline.id)
      } else if (pipeline.kind === OperationKind.ProposerRun) {
        await api.cancelProposerRun(pipeline.id)
      } else if (pipeline.kind === OperationKind.SyncPreview) {
        await api.cancelSyncPreview(syncPlanIdFromPipeline(pipeline))
      } else if (pipeline.kind === OperationKind.SyncExecute) {
        await api.cancelSyncExecute(syncPlanIdFromPipeline(pipeline))
      } else if (pipeline.kind === OperationKind.SyncRun) {
        const planId = syncPlanIdFromPipeline(pipeline)
        try {
          await api.cancelSyncExecute(planId)
        } catch {
          await api.cancelSyncPreview(planId)
        }
      } else if (
        pipeline.kind === OperationKind.BridgePreview ||
        pipeline.kind === OperationKind.BridgeRun
      ) {
        await api.cancelBridgeMove(bridgeMoveIdFromPipeline(pipeline))
      }
    } catch (err: unknown) { console.error("[mia]", err) } finally {
      setCancellingId(null)
    }
  }, [])

  // ── Toggle helpers ────────────────────────────────────────────
  const toggleActivity = useCallback((key: string) => {
    setActExpanded(s => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n })
  }, [])
  const toggleDay = useCallback((label: string) => {
    setCollapsedDays(s => { const n = new Set(s); n.has(label) ? n.delete(label) : n.add(label); return n })
  }, [])

  const needle = search.trim().toLowerCase()
  const serverSearchActive = needle.length >= 2

  const filtered = useMemo(() => pipelines.filter((p) => {
    if (!pipelineMatchesKinds(p, kinds)) return false
    if (statuses.size > 0 && !statuses.has(p.status)) return false
    if (!serverSearchActive && needle && !matchesPipeline(p, needle)) return false
    return true
  }), [pipelines, kinds, statuses, needle, serverSearchActive])

  const pipelineById = useMemo(() => {
    const map = new Map<string, OperationPipeline>()
    for (const pipeline of filtered) map.set(pipeline.id, pipeline)
    return map
  }, [filtered])

  const openTopLevelActivities = useCallback((pipeline: OperationPipeline) => {
    setActExpanded((s) => {
      let changed = false
      const n = new Set(s)
      for (const activity of pipeline.activities) {
        const key = pipelineActivityKey(pipeline.id, activity.id)
        if ((activity.children?.length ?? 0) > 0 && !n.has(key)) {
          n.add(key)
          changed = true
        }
      }
      return changed ? n : s
    })
  }, [])

  const openPipelineTree = useCallback((pipelineId: string) => {
    const target = pipelineById.get(pipelineId)
    setOpenPipelineIds((s) => {
      if (s.has(pipelineId)) return s
      const n = new Set(s)
      n.add(pipelineId)
      return n
    })
    if (target) openTopLevelActivities(target)
  }, [pipelineById, openTopLevelActivities])

  const togglePipelineTree = useCallback((pipelineId: string) => {
    const target = pipelineById.get(pipelineId)
    const wasOpen = openPipelineIds.has(pipelineId)
    setOpenPipelineIds((s) => {
      const n = new Set(s)
      if (n.has(pipelineId)) n.delete(pipelineId)
      else n.add(pipelineId)
      return n
    })
    if (!wasOpen && target) openTopLevelActivities(target)
  }, [pipelineById, openPipelineIds, openTopLevelActivities])

  const selectPipeline = useCallback((pipelineId: string) => {
    setSelection({ kind: "pipeline", pipelineId })
    openPipelineTree(pipelineId)
  }, [openPipelineTree])

  const selectActivity = useCallback((pipelineId: string, activityKey: string) => {
    setSelection({ kind: "activity", pipelineId, activityKey })
    openPipelineTree(pipelineId)
  }, [openPipelineTree])

  const selectedPipelineId = selection?.pipelineId ?? null
  const selectedPipeline = selectedPipelineId
    ? pipelineById.get(selectedPipelineId) ?? null
    : null

  useEffect(() => {
    if (filtered.length === 0) {
      setSelection(null)
      return
    }
    if (!selectedPipelineId || !pipelineById.has(selectedPipelineId)) {
      const first = filtered[0]!
      setSelection({ kind: "pipeline", pipelineId: first.id })
      setOpenPipelineIds((s) => {
        if (s.has(first.id)) return s
        const n = new Set(s)
        n.add(first.id)
        return n
      })
      openTopLevelActivities(first)
    }
  }, [filtered, pipelineById, selectedPipelineId, openTopLevelActivities])

  function onSplitPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const shell = splitShellRef.current
    if (!shell) return
    splitDragRef.current = beginSplitPaneDrag(event, shell, splitRatio)
  }

  function onSplitPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = splitDragRef.current
    if (!drag) return
    setSplitRatio(moveSplitPaneDrag(drag, event, OP_LOG_SPLIT_MIN, OP_LOG_SPLIT_MAX))
  }

  function onSplitPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    endSplitPaneDrag(splitDragRef.current, event)
    splitDragRef.current = null
  }

  function onSplitPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    endSplitPaneDrag(splitDragRef.current, event)
    splitDragRef.current = null
  }

  const searchPending = serverSearchActive && loading

  useEffect(() => {
    if (!hasMore || loading || loadingMore) return
    const root = listScrollRef.current
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
  }, [hasMore, loadMore, loading, loadingMore, filtered.length])

  const emptyMessage = useMemo(() => {
    if (error) return error
    if (pipelines.length === 0) {
      const hasTime =
        Boolean(timeWindow.from || timeWindow.to) || timeWindow.range !== "live"
      if (hasTime) return "No operations in this time range."
      return "No operations recorded yet."
    }
    if (kinds.size > 0 || statuses.size > 0) return "No operations match the selected filters."
    if (needle) return "No operations match your search."
    return "No operations recorded yet."
  }, [error, pipelines.length, kinds.size, statuses.size, needle, timeWindow])

  return (
    <OperationLogModalsProvider>
    <div ref={rootRef} className={`${WIDGET_LOG_SHELL_CLASS} flex-1 ${OP_LOG}`}>
      <div className={`${WIDGET_LOG_STACK_CLASS} min-h-0 flex-1`}>
      <OperationLogToolbar
        kinds={kinds}
        setKinds={setKinds}
        statuses={statuses}
        setStatuses={setStatuses}
        search={search}
        setSearch={setSearch}
        searchPending={searchPending}
        timeWindow={timeWindow}
        setQuickRange={setQuickRange}
        setFromDate={setFromDate}
        setToDate={setToDate}
        tiny={tiny}
        filteredCount={filtered.length}
        totalCount={pipelines.length}
      />

      <div className={`op-log-split-body trace-split-body ${WIDGET_LOG_BODY_CLASS} min-h-0 flex-1`}>
        {loading && filtered.length === 0 ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-muted/60">
            <Loader2 size={14} className="animate-spin" />
            Loading operations…
          </div>
        ) : !loading && filtered.length === 0 ? (
          <EmptyState icon={WIDGET_ICONS["operation-log"]} message={emptyMessage} />
        ) : (
          <div className="trace-split-host relative min-h-0 flex-1 overflow-hidden">
            <div
              ref={splitShellRef}
              className="op-log-split-shell trace-split-shell trace-split-shell--resizable entity-registry-shell widget-split-shell grid h-full min-h-0 overflow-hidden"
              style={{
                gridTemplateColumns: `${Math.round(splitRatio * 1000) / 10}% 4px minmax(0, 1fr)`,
              }}
            >
              <div className="op-log-split-list widget-split-sidebar flex min-h-0 min-w-0 flex-col overflow-hidden">
                <div className="op-log-split-list__cap shrink-0 border-b border-border-subtle py-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Tree
                </div>
                <div ref={listScrollRef} className="op-log-split-list-scroll min-h-0 flex-1 overflow-y-auto">
                  <OperationPipelineList
                    scrollRef={listScrollRef}
                    pipelines={filtered}
                    selection={selection}
                    onSelectPipeline={selectPipeline}
                    onSelectActivity={selectActivity}
                    openPipelineIds={openPipelineIds}
                    togglePipelineTree={togglePipelineTree}
                    actExpanded={actExpanded}
                    toggleActivity={toggleActivity}
                    collapsedDays={collapsedDays}
                    toggleDay={toggleDay}
                  />
                  {hasMore ? (
                    <div ref={sentinelRef} className="py-4 flex justify-center">
                      {loadingMore ? (
                        <span className="text-sm text-text-muted/60 flex items-center gap-2">
                          <Loader2 size={12} className="animate-spin" />
                          Loading more…
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
              <div
                className="trace-split-handle"
                role="separator"
                aria-orientation="vertical"
                aria-valuenow={Math.round(splitRatio * 100)}
                aria-valuemin={Math.round(OP_LOG_SPLIT_MIN * 100)}
                aria-valuemax={Math.round(OP_LOG_SPLIT_MAX * 100)}
                onPointerDown={onSplitPointerDown}
                onPointerMove={onSplitPointerMove}
                onPointerUp={onSplitPointerUp}
                onPointerCancel={onSplitPointerCancel}
              />
              <div className="op-log-split-detail widget-split-main flex min-h-0 min-w-0 flex-col overflow-hidden">
                <div className="widget-split-inset flex min-h-0 flex-1 flex-col overflow-hidden">
                  <OperationLogInspector
                    pipeline={selectedPipeline}
                    selection={selection}
                    keyOf={pipelineActivityKey}
                    onCancel={cancelPipeline}
                    cancelling={cancellingId === selectedPipeline?.id}
                  />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
    </OperationLogModalsProvider>
  )
}

export function OperationPipelineList({
  pipelines,
  selection,
  onSelectPipeline,
  onSelectActivity,
  openPipelineIds,
  togglePipelineTree,
  actExpanded,
  toggleActivity,
  collapsedDays,
  toggleDay,
  scrollRef,
}: {
  pipelines: OperationPipeline[]
  selection: OpLogSelection | null
  onSelectPipeline: (id: string) => void
  onSelectActivity: (pipelineId: string, activityKey: string) => void
  openPipelineIds: Set<string>
  togglePipelineTree: (id: string) => void
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  collapsedDays: Set<string>
  toggleDay: (label: string) => void
  scrollRef?: RefObject<HTMLElement | null>
}) {
  const rows = useMemo(
    () =>
      flattenOperationRows(pipelines, collapsedDays, dayLabel, {
        openPipelineIds,
        openActivityKeys: actExpanded,
        activityKeyOf: pipelineActivityKey,
      }),
    [pipelines, collapsedDays, openPipelineIds, actExpanded],
  )

  const renderRow = (row: (typeof rows)[number], index: number) => {
    if (row.type === "day") {
      const collapsed = collapsedDays.has(row.label)
      return (
        <div key={row.key} className={dayGroupWrapClass(index === 0)}>
          <button
            type="button"
            className={DAY_GROUP_BTN_LINEAR}
            onClick={() => toggleDay(row.label)}
          >
            <ChevronRight size={10} className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`} />
            {row.label}
            <span className="ml-1 text-text-muted/30 normal-case tracking-normal">{row.count}</span>
          </button>
        </div>
      )
    }
    if (row.type === "activity") {
      const effectiveKind = activityPipelineKind(row.pipeline.kind, row.parentPhaseId)
      const status = effectiveActivityStatus(row.activity, row.pipeline.status)
      const label = formatActivityName(effectiveKind, row.activity)
      const summary = defaultActivitySummary(effectiveKind, row.activity)
      return (
        <OperationLogActivityTreeRow
          key={row.key}
          activity={row.activity}
          label={label}
          summary={summary}
          status={status}
          depth={row.depth}
          selected={
            selection?.kind === "activity" && selection.activityKey === row.activityKey
          }
          hasChildren={row.hasChildren}
          folded={!actExpanded.has(row.activityKey)}
          onSelect={() => onSelectActivity(row.pipeline.id, row.activityKey)}
          onToggleFold={() => toggleActivity(row.activityKey)}
        />
      )
    }
    return (
      <OperationLogPipelineListRow
        key={row.key}
        pipeline={row.pipeline}
        selected={
          selection?.pipelineId === row.pipeline.id && selection.kind === "pipeline"
        }
        hasChildren={row.pipeline.activities.length > 0}
        folded={!openPipelineIds.has(row.pipeline.id)}
        onSelect={onSelectPipeline}
        onToggleFold={togglePipelineTree}
      />
    )
  }

  if (!scrollRef) {
    return <div className="op-log-split-list__items">{rows.map(renderRow)}</div>
  }

  return (
    <VirtualList
      items={rows}
      scrollRef={scrollRef}
      estimateSize={(index) => {
        const row = rows[index]
        if (!row) return OP_LOG_LIST_ROW_HEIGHT
        if (row.type === "day") return index === 0 ? 28 : 42
        if (row.type === "activity") return opLogActivityTreeRowHeight()
        return opLogPipelineListRowHeight(row.pipeline)
      }}
      getItemKey={(_i, item) => item.key}
      renderItem={({ item, index }) => renderRow(item, index)}
    />
  )
}

/** Inspector timeline — activities, steps, JSON payloads for one pipeline. */
export function OperationLogPipelineTimeline({
  pipeline,
  actExpanded,
  toggleActivity,
  evExpanded,
  toggleEvent,
}: {
  pipeline: OperationPipeline
  actExpanded: Set<string>
  toggleActivity: (key: string) => void
  evExpanded: Set<string>
  toggleEvent: (key: string) => void
}) {
  return (
    <div className="op-log-tree-table op-log-tree-table--inspector">
      <OpLogTreeHeader />
      <LogNest linear>
        {pipeline.activities.length === 0 && (
          <ReviewTreeItem>
            <div className="py-2 pr-3 text-sm text-text-muted">No activities recorded.</div>
          </ReviewTreeItem>
        )}
        {pipeline.activities.map((a, idx) => {
          const key = pipelineActivityKey(pipeline.id, a.id)
          return (
            <ActivityRow
              key={key}
              activityKey={key}
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
    </div>
  )
}

// ── Pipeline row (legacy inline — retained for embed parity) ─────

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
  const canCancel =
    pipeline.status === "running" &&
    onCancel &&
    pipeline.kind !== OperationKind.System
  const formattedSubtitle = pipeline.subtitle
    ? formatPipelineSubtitle(pipeline.subtitle)
    : null
  const showPipelineError =
    pipeline.error &&
    pipeline.status === OperationStatus.Failed
  const entity = pipelineEntityIcon(pipeline.kind)

  const pipelineHeader = (
    <PipelineRowCells
      expanded={expanded}
      status={pipeline.status}
      entityIcon={entity.Icon}
      entityIconColor={entity.color}
      title={pipeline.title}
      subtitle={formattedSubtitle && !compact ? formattedSubtitle : undefined}
      counts={
        !linear
          ? `${pipeline.activityCount} act · ${pipeline.eventCount} ev`
          : undefined
      }
      durationMs={pipeline.durationMs}
      timestamp={pipeline.startedAt}
      wide={!linear}
    />
  )

  const expandedBody = expanded ? (
    <LogNest linear={linear}>
      {showPipelineError && pipeline.error ? (
        <OpLogErrorTreeRow message={pipeline.error} />
      ) : null}
      {pipeline.activities.length === 0 && (
        <ReviewTreeItem>
          <div className="py-2 pr-3 text-sm text-text-muted">No activities recorded.</div>
        </ReviewTreeItem>
      )}
      {pipeline.activities.map((a, idx) => {
        const key = pipelineActivityKey(pipeline.id, a.id)
        return (
          <ActivityRow
            key={key}
            activityKey={key}
            linear={linear}
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
  ) : null

  if (linear) {
    return (
      <div className="border-b border-border-subtle last:border-b-0">
        <div className="flex items-center gap-1 pr-1">
          <button
            type="button"
            className={[
              "min-w-0 flex-1 py-2 pr-2.5 text-left",
              opLogRowChromeClass(expanded),
            ].join(" ")}
            onClick={onToggle}
          >
            {pipelineHeader}
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
        {expandedBody}
      </div>
    )
  }

  return (
    <LogGroup>
      <div className="flex items-center gap-1 pr-1">
        <button
          type="button"
          className={[
            "min-w-0 flex-1 py-2 pr-2.5 text-left",
            opLogRowChromeClass(expanded),
          ].join(" ")}
          onClick={onToggle}
        >
          {pipelineHeader}
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
      {expandedBody}
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
      showStatusPill={opLogShowStatusPill({ status })}
      showChevron
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
  return (
    <OpLogRow
      linear={linear}
      isLast={isLast && !expanded}
      depth={depth}
      expanded={expanded}
      expandable={expandable}
      onToggle={onToggle}
      status={OperationStatus.Success}
      showStatusPill={false}
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
      {expanded && resultData ? (
        <OpLogNestedBlock depth={depth + 1}>
          <JsonViewer value={resultData} label="result" defaultExpandDepth={2} maxHeight={480} />
        </OpLogNestedBlock>
      ) : null}
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
      status={failed ? OperationStatus.Failed : OperationStatus.Success}
      showStatusPill={opLogShowStatusPill({
        status: failed ? OperationStatus.Failed : OperationStatus.Success,
      })}
      label={<span className={`${OP_LOG_MONO} ${OP_LOG_MUTED}`}>HTTP</span>}
      meta={summary}
      durationMs={fields?.durationMs ?? null}
      timestamp={ev.timestamp}
    >
      {expanded && (
        <OpLogNestedBlock depth={depth + 1}>
          <JsonViewer value={detail} label="http" defaultExpandDepth={2} maxHeight={360} />
        </OpLogNestedBlock>
      )}
    </OpLogRow>
  )
}

// ── Activity row ─────────────────────────────────────────────────

function ActivityRow({ activityKey, activity, pipelineKind, pipelineId, pipelineStatus, pipelineError, parentStatus, parentPhaseId, depth = 0, expanded, onToggle, actExpanded, toggleActivity, evExpanded, toggleEvent, linear, isLast }: {
  activityKey: string
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
  const isAgentToolStep =
    effectiveKind === OperationKind.AgentRun && toolIo != null && !isFlowStep && !isResultRow
  const inlineError =
    !isResultRow &&
    resultChild == null &&
    activity.error &&
    !isDuplicatePipelineMessage(pipelineError, activity.error)
      ? activity.error
      : null
  const renderedSummary = activityRowSummary(effectiveKind, activity, {
    expanded,
    toolIo,
    isAgentToolStep,
  })
  const showPill = opLogShowStatusPill({ status })
  // Agent tool rows: I/O is first-class (button + ToolIoBlock). Nested step.* /
  // tool_call.* EventRows only repeat that payload with input/output stripped —
  // hide them so every tool reads as clearly as ask_user.
  const visibleEvents = filterFlowStepVisibleEvents(
    effectiveKind,
    activity,
    activity.events.filter((ev) => {
      if (isRedundantActivityEvent(activity, ev)) return false
      if (isSyncSqlEventType(ev.type) || isSyncHttpEventType(ev.type)) return false
      if (shouldHideSyncExecuteStepEvent(effectiveKind, activity, ev)) return false
      if (isAgentToolStep) {
        if (isAgentStepEventType(ev.type)) return false
        if (ev.type.startsWith("tool_call.")) return false
      }
      return true
    }),
  )

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
  const hasNestableContent =
    countActivityNestableRows({
      inlineError,
      isFlowStep,
      isResultRow,
      isAgentToolStep,
      hasChildren,
      sqlEvents,
      httpEvents,
      visibleEvents,
      activity,
      toolIo,
    }) > 0
  const hasExpandedContent = expanded && hasNestableContent

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

  // Nest MUST live inside OpLogRow (ReviewTreeItem). A sibling LogNest breaks
  // the parent stem — gap between Configured → Preview (and every peer after
  // an expanded activity).
  return (
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
      showStatusPill={showPill}
      expanded={expanded}
      expandable={hasNestableContent}
      onToggle={onToggle}
      label={<span className={`${OP_LOG_MONO} ${OP_LOG_MUTED}`}>{renderedName}</span>}
      meta={!inlineError && renderedSummary && !isResultRow ? renderedSummary : undefined}
      durationMs={activity.durationMs}
      timestamp={activity.startedAt}
      actions={rowActions}
    >
      {expanded ? (
        <LogNest linear={linear}>
          {inlineError ? <OpLogErrorTreeRow message={inlineError} depth={depth + 1} /> : null}
          {isFlowStep && sqlEvents.map((ev, idx) => {
            const key = pipelineEventKey(activityKey, `sql:${idx}`)
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
            const key = pipelineEventKey(activityKey, `http:${idx}`)
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
            <ReviewTreeItem>
              <OpLogNestedBlock depth={depth + 1}>
                <JsonViewer
                  value={activity.events[0].data}
                  label="result"
                  defaultExpandDepth={2}
                  maxHeight={480}
                />
              </OpLogNestedBlock>
            </ReviewTreeItem>
          )}
          {isAgentToolStep && toolIo && (
            <ReviewTreeItem>
              <OpLogNestedBlock depth={depth + 1}>
                <ToolIoBlock io={toolIo} compact maxHeight={320} />
              </OpLogNestedBlock>
            </ReviewTreeItem>
          )}
          {!isResultRow && !isAgentToolStep && activity.events.length === 0 && activity.details && !inlineError && (
            <>
              {toolIo && (
                <ReviewTreeItem>
                  <OpLogNestedBlock depth={depth + 1}>
                    <ToolIoBlock io={toolIo} compact maxHeight={280} />
                  </OpLogNestedBlock>
                </ReviewTreeItem>
              )}
              {activity.details && Object.keys(activity.details).length > 0 && !toolIo && (
                isSyncDecisionLogDetails(activity.details) ? (
                  <DecisionLogPanel decisions={activity.details.decisions} linear={linear} depth={depth + 1} />
                ) : (
                  <ReviewTreeItem>
                    <OpLogNestedBlock depth={depth + 1}>
                      <JsonViewer value={activity.details} label="details" defaultExpandDepth={2} maxHeight={280} />
                    </OpLogNestedBlock>
                  </ReviewTreeItem>
                )
              )}
            </>
          )}
          {hasChildren && !isResultRow && activity.children!.map((child, idx) => {
            const childKey = pipelineActivityKey(pipelineId, child.id, activityKey)
            return (
              <ActivityRow
                key={childKey}
                activityKey={childKey}
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
            const key = pipelineEventKey(activityKey, `ev:${idx}`)
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
            const key = pipelineEventKey(activityKey, `misc:${idx}`)
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
      ) : null}
    </OpLogRow>
  )
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
        expandable={eventRowExpandable(ev)}
        onToggle={onToggle}
        status={evStatus}
        showStatusPill={opLogShowStatusPill({ status: evStatus })}
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
        {eventRowExpandable(ev) ? (
          <OpLogNestedBlock depth={depth + 1}>
            <JsonViewer value={displayData} label="event" defaultExpandDepth={3} maxHeight={360} />
          </OpLogNestedBlock>
        ) : null}
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
