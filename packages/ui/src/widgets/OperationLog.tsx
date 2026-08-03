/**
 * Operation Log — audit-oriented view of platform activity (pipelines → steps → events).
 *
 * Data: paginated GET /api/operations (SQLite event_log). SSE only signals refresh.
 */

import { ChevronRight, Loader2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import type { OperationActivity, OperationPipeline } from "../client/index"
import { api, OperationKind, OperationStatus } from "../client/index"
import { VirtualList } from "../components/VirtualList"
import { ReviewSplitPane } from "../components/review"
import { EmptyState } from "../components/EmptyState"
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
import { OperationLogModalsProvider } from "./pipelines/operation-log-modals"
import { WIDGET_ICONS } from "./widget-icons"
import { OP_LOG } from "./pipelines/operation-log-row"
import {
  WIDGET_LOG_BODY_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
} from "./widget-toolbar"
import { OperationLogToolbar } from "./operation-log-toolbar"
import { OperationLogInspector } from "./pipelines/OperationLogInspector"
import {
  OperationLogActivityTreeRow,
  opLogActivityTreeRowHeight,
} from "./pipelines/OperationLogActivityTreeRow"
import { OperationLogPipelineListRow, opLogPipelineListRowHeight } from "./pipelines/OperationLogPipelineListRow"
import {
  treeOpenStateForFoldMode,
  type OpLogTreeFoldMode,
} from "./pipelines/op-log-tree-open-state"
import type { OpLogSelection } from "./pipelines/OperationLogScopeDetail"

const OP_LOG_SPLIT_MIN = 0.28
const OP_LOG_SPLIT_MAX = 0.62
const OP_LOG_SPLIT_DEFAULT = 0.4
const OP_LOG_LIST_ROW_HEIGHT = 44

const DAY_GROUP_BTN =
  "review-group-label review-group-cap op-log-day-cap sticky top-0 z-10 w-full flex items-center text-left transition-colors"

function dayLabel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "Unknown"
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const day = new Date(d)
  day.setHours(0, 0, 0, 0)
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
    p.title,
    p.subtitle ?? "",
    p.id,
    p.error ?? "",
    p.planId ?? "",
    ...activityHay(p.activities),
  ]
    .join(" ")
    .toLowerCase()
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
    if (
      activity.name === "phases" ||
      activity.name === "other events" ||
      activity.name.startsWith("tbl:")
    ) {
      return activity.name
    }
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
  parentStatus?: OperationStatus,
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

function defaultActivitySummary(
  pipelineKind: OperationKind,
  activity: OperationActivity,
): string | undefined {
  if (activity.name === "result") return undefined
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
    (pipeline.kind === OperationKind.BridgePreview || pipeline.kind === OperationKind.BridgeRun)
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
  const [treeFoldMode, setTreeFoldMode] = useState<OpLogTreeFoldMode>("collapsed")
  const [splitRatio, setSplitRatio] = useState(OP_LOG_SPLIT_DEFAULT)
  const rootRef = useRef<HTMLDivElement>(null)
  const listScrollRef = useRef<HTMLDivElement>(null)
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
    } catch (err: unknown) {
      console.error("[mia]", err)
    } finally {
      setCancellingId(null)
    }
  }, [])

  const toggleActivity = useCallback((key: string) => {
    setActExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  }, [])
  const toggleDay = useCallback((label: string) => {
    setCollapsedDays((s) => {
      const n = new Set(s)
      if (n.has(label)) n.delete(label)
      else n.add(label)
      return n
    })
  }, [])

  const needle = search.trim().toLowerCase()
  const serverSearchActive = needle.length >= 2

  const filtered = useMemo(
    () =>
      pipelines.filter((p) => {
        if (!pipelineMatchesKinds(p, kinds)) return false
        if (statuses.size > 0 && !statuses.has(p.status)) return false
        if (!serverSearchActive && needle && !matchesPipeline(p, needle)) return false
        return true
      }),
    [pipelines, kinds, statuses, needle, serverSearchActive],
  )

  const onTreeFoldModeChange = useCallback((mode: OpLogTreeFoldMode) => {
    setTreeFoldMode(mode)
  }, [])

  useEffect(() => {
    const next = treeOpenStateForFoldMode(filtered, treeFoldMode, pipelineActivityKey)
    setOpenPipelineIds(next.openPipelineIds)
    setActExpanded(next.actExpanded)
    if (treeFoldMode === "expanded") setCollapsedDays(next.collapsedDays)
  }, [filtered, treeFoldMode])

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

  const openPipelineTree = useCallback(
    (pipelineId: string) => {
      const target = pipelineById.get(pipelineId)
      setOpenPipelineIds((s) => {
        if (s.has(pipelineId)) return s
        const n = new Set(s)
        n.add(pipelineId)
        return n
      })
      if (target) openTopLevelActivities(target)
    },
    [pipelineById, openTopLevelActivities],
  )

  const togglePipelineTree = useCallback(
    (pipelineId: string) => {
      const target = pipelineById.get(pipelineId)
      const wasOpen = openPipelineIds.has(pipelineId)
      setOpenPipelineIds((s) => {
        const n = new Set(s)
        if (n.has(pipelineId)) n.delete(pipelineId)
        else n.add(pipelineId)
        return n
      })
      if (!wasOpen && target) openTopLevelActivities(target)
    },
    [pipelineById, openPipelineIds, openTopLevelActivities],
  )

  const selectPipeline = useCallback(
    (pipelineId: string) => {
      setSelection({ kind: "pipeline", pipelineId })
      openPipelineTree(pipelineId)
    },
    [openPipelineTree],
  )

  const selectActivity = useCallback(
    (pipelineId: string, activityKey: string) => {
      setSelection({ kind: "activity", pipelineId, activityKey })
      openPipelineTree(pipelineId)
    },
    [openPipelineTree],
  )

  const selectedPipelineId = selection?.pipelineId ?? null
  const selectedPipeline = selectedPipelineId
    ? (pipelineById.get(selectedPipelineId) ?? null)
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
      <div ref={rootRef} className={`${WIDGET_LOG_SHELL_CLASS} review-operator flex-1 ${OP_LOG}`}>
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
            treeFoldMode={treeFoldMode}
            onTreeFoldModeChange={onTreeFoldModeChange}
          />

          <div className={`review-split-body ${WIDGET_LOG_BODY_CLASS} min-h-0 flex-1`}>
            {loading && filtered.length === 0 ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-muted/60">
                <Loader2 size={14} className="animate-spin" />
                Loading operations…
              </div>
            ) : !loading && filtered.length === 0 ? (
              <EmptyState icon={WIDGET_ICONS["operation-log"]} message={emptyMessage} />
            ) : (
              <ReviewSplitPane
                ratio={splitRatio}
                onRatioChange={setSplitRatio}
                minRatio={OP_LOG_SPLIT_MIN}
                maxRatio={OP_LOG_SPLIT_MAX}
                sidebar={
                  <div className="review-split-list widget-split-sidebar flex min-h-0 min-w-0 flex-col overflow-hidden">
                    <div className="review-split-tree-table">
                      <div
                        ref={listScrollRef}
                        className="review-split-list-scroll min-h-0 flex-1 overflow-y-auto"
                      >
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
                          <div ref={sentinelRef} className="flex justify-center py-4">
                            {loadingMore ? (
                              <span className="flex items-center gap-2 text-sm text-text-muted/60">
                                <Loader2 size={12} className="animate-spin" />
                                Loading more…
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                }
                main={
                  <div className="review-split-detail widget-split-main flex min-h-0 min-w-0 flex-col overflow-hidden">
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
                }
              />
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

  const renderRow = (row: (typeof rows)[number], _index: number) => {
    if (row.type === "day") {
      const collapsed = collapsedDays.has(row.label)
      return (
        <button
          key={row.key}
          type="button"
          className={DAY_GROUP_BTN}
          onClick={() => toggleDay(row.label)}
        >
          <ChevronRight
            size={12}
            className={`shrink-0 transition-transform ${collapsed ? "" : "rotate-90"}`}
          />
          <span className="op-log-day-cap__label">{row.label}</span>
          <span className="review-group-cap__count">{row.count}</span>
        </button>
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
          guideSlots={row.guideSlots}
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
    return <div className="review-split-list__items">{rows.map(renderRow)}</div>
  }

  return (
    <VirtualList
      items={rows}
      scrollRef={scrollRef}
      estimateSize={(index) => {
        const row = rows[index]
        if (!row) return OP_LOG_LIST_ROW_HEIGHT
        if (row.type === "day") return 32
        if (row.type === "activity") return opLogActivityTreeRowHeight()
        return opLogPipelineListRowHeight(row.pipeline)
      }}
      getItemKey={(_i, item) => item.key}
      renderItem={({ item, index }) => renderRow(item, index)}
    />
  )
}
