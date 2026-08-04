/**
 * Trace master-detail shell — metric tree (left) + sticky inspector (right).
 * Selection drives the inspector; chevrons fold tree children only.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { api } from "../../client/index"
import { VirtualList } from "../../components/VirtualList"
import { BrowseCount } from "../../components/BrowseStrip"
import { useWidgetFocus } from "../../hooks/useWidgetFocus"
import { useWidgetInstance } from "../../app/workspace/widget-instance"
import { useLayoutStore } from "../../state/layout-store"
import {
  beginSplitPaneDrag,
  endSplitPaneDrag,
  moveSplitPaneDrag,
  type SplitPaneDragState,
} from "../../lib/split-pane-drag"
import { ReviewTreeFoldToggle } from "../../components/review"
import { fmtTokens, formatMs } from "../../lib/util"
import { SegmentToggle } from "../entity-registry/SegmentToggle"
import {
  WIDGET_LOG_BODY_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
  WIDGET_REVIEW_CONTROLS_CLASS,
  WIDGET_REVIEW_CONTROLS_INSET_CLASS,
  WidgetToolbar,
  WidgetToolbarLeading,
  WidgetToolbarSearch,
  WidgetToolbarTrailing,
} from "../widget-toolbar"
import { normalizeTraceWire } from "../../lib/events/trace-wire"
import {
  buildTraceDag,
  type TraceDag,
} from "./build-trace-dag"
import { buildTraceTreeSearch, traceSearchSummary } from "./trace-tree-search"
import { type CompareRunRow, nodeSupportsCompare, previousRunInThread, priorRunsInThread } from "./trace-run-compare"
import {
  emptyOpen,
  seedLatest,
  openStateForFoldMode,
  pruneOpenState,
  type FoldMode,
  type OpenState,
} from "./open-state"
import {
  readTraceTreePrefs,
  writeTraceTreePrefs,
} from "./trace-tree-prefs"
import {
  buildTraceTreeIndex,
  defaultSelectedScopeId,
  findDeepestFailure,
  openStateRevealingScope,
  resolveSelectionScopeId,
  type TraceTreeNode,
} from "./trace-tree-index"
import { TraceDetailInspector } from "./TraceDetailInspector"
import { IdChip } from "./TraceCopy"
import { TraceExportMenu } from "./TraceExportMenu"
import { TraceTreeRow, traceTreeRowEstimateSize } from "./TraceTreeRow"
import { TraceWaterfallView } from "./TraceWaterfallView"
import { TraceZenHud } from "./TraceZenHud"
import { useTraceZenHotkeys } from "./use-trace-zen-hotkeys"
import { operationStatusPill } from "../../lib/status-callout"

export const TRACE_TREE_OVERSCAN = 8
const TRACE_SPLIT_MIN = 0.28
const TRACE_SPLIT_MAX = 0.62
const TRACE_SPLIT_DEFAULT = 0.4

type ViewMode = "tree" | "waterfall"

export function TraceDag({
  dag,
  runId,
  threadId,
  runs,
  emptySlot,
  onExportMessage,
  onExportError,
}: {
  dag: TraceDag
  runId: string | null
  threadId: string | null
  runs: Array<{
    id: string
    threadId?: string | null
    createdAt?: string
    status?: string
  }>
  emptySlot?: ReactNode
  onExportMessage?: (message: string) => void
  onExportError?: (message: string) => void
}) {
  const { isZen, isSolo, toggleZen, exitZen } = useWidgetFocus()
  const widgetInstance = useWidgetInstance()
  const tileId = widgetInstance?.widgetId ?? null
  const focusedTileId = useLayoutStore((s) => s.focusedTileId)
  const zenHotkeysEnabled =
    isZen || isSolo || Boolean(widgetInstance && focusedTileId === widgetInstance.widgetId)

  const [search, setSearch] = useState("")
  const [openState, setOpenState] = useState<OpenState>(() =>
    readTraceTreePrefs(tileId, runId) ?? emptyOpen(),
  )
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("tree")
  const [playgroundOpen, setPlaygroundOpen] = useState(false)
  const [compareRunId, setCompareRunId] = useState<string | null>(null)
  const [compareDag, setCompareDag] = useState<TraceDag | null>(null)
  const [zenSearchOpen, setZenSearchOpen] = useState(false)
  const [splitRatio, setSplitRatio] = useState(TRACE_SPLIT_DEFAULT)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const splitShellRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef<SplitPaneDragState | null>(null)
  /** True once we have either restored prefs or applied first-visit seed. */
  const seededRef = useRef(readTraceTreePrefs(tileId, runId) != null)
  /** Gate writes so the empty pre-seed state cannot wipe sessionStorage. */
  const persistReadyRef = useRef(seededRef.current)
  const searchSeedRef = useRef("")
  const hadSearchRef = useRef(false)
  const prevRunIdRef = useRef(runId)

  const query = search.trim()
  const { stats } = dag

  const treeSearch = useMemo(
    () => buildTraceTreeSearch(dag, query, runId, threadId),
    [dag, query, runId, threadId],
  )

  const treeIndex = useMemo(
    () => buildTraceTreeIndex(dag, openState, treeSearch),
    [dag, openState, treeSearch],
  )

  const priorRuns = useMemo(
    (): CompareRunRow[] => priorRunsInThread(runs, runId),
    [runs, runId],
  )

  const selectedNode = selectedScopeId ? treeIndex.byScopeId.get(selectedScopeId) : null
  const canCompare = selectedNode ? nodeSupportsCompare(dag, selectedNode) : false

  useTraceZenHotkeys({
    enabled: zenHotkeysEnabled,
    isZen,
    searchOpen: zenSearchOpen,
    onSearchOpenChange: setZenSearchOpen,
    onViewModeChange: setViewMode,
    viewMode,
    foldMode: openState.foldMode,
    onFoldModeChange,
    onToggleZen: toggleZen,
    onExitZen: exitZen,
  })

  useEffect(() => {
    if (!isZen) setZenSearchOpen(false)
  }, [isZen])

  function onSplitPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const shell = splitShellRef.current
    if (!shell) return
    splitDragRef.current = beginSplitPaneDrag(event, shell, splitRatio)
  }

  function onSplitPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = splitDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    setSplitRatio(moveSplitPaneDrag(drag, event, TRACE_SPLIT_MIN, TRACE_SPLIT_MAX))
  }

  function onSplitPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    endSplitPaneDrag(splitDragRef.current, event)
    splitDragRef.current = null
  }

  function onSplitPointerCancel(event: ReactPointerEvent<HTMLDivElement>) {
    endSplitPaneDrag(splitDragRef.current, event)
    splitDragRef.current = null
  }

  useEffect(() => {
    if (prevRunIdRef.current === runId) return
    prevRunIdRef.current = runId
    searchSeedRef.current = ""
    const restored = readTraceTreePrefs(tileId, runId)
    setOpenState(restored ?? emptyOpen())
    setSelectedScopeId(null)
    setPlaygroundOpen(false)
    setCompareRunId(null)
    setCompareDag(null)
    seededRef.current = restored != null
    persistReadyRef.current = restored != null
  }, [runId, tileId])

  // First visit for this run: seed latest open path. Returning visits keep prefs.
  useEffect(() => {
    if (seededRef.current || (dag.calls.length === 0 && dag.spine.length === 0)) return
    const restored = readTraceTreePrefs(tileId, runId)
    if (restored) {
      seededRef.current = true
      persistReadyRef.current = true
      setOpenState(pruneOpenState(restored, dag))
      return
    }
    seededRef.current = true
    persistReadyRef.current = true
    setOpenState((prev) => {
      const next = seedLatest(dag.calls.length)
      const lastCall = dag.calls.length - 1
      const lastWork = [...dag.spine].reverse().find((e) => e.kind === "work")
      if (lastWork && lastWork.kind === "work") {
        next.work.add(lastWork.work.id)
      }
      function seedPhase(phase: import("./build-trace-dag").TracePhaseNode): boolean {
        let owns = false
        for (const child of phase.children ?? []) {
          if (child.kind === "call" && child.callIndex === lastCall) owns = true
          if (child.kind === "work") {
            next.work.add(child.work.id)
            if (child.work.afterCallIndex === lastCall) owns = true
          }
          if (child.kind === "phase" && seedPhase(child.phase)) owns = true
        }
        if (owns) next.phases.add(phase.id)
        return owns
      }
      for (const entry of dag.spine) {
        if (entry.kind === "phase") seedPhase(entry.phase)
      }
      return { ...next, foldMode: prev.foldMode }
    })
  }, [dag, tileId, runId])

  useEffect(() => {
    if (!seededRef.current) return
    if (dag.calls.length === 0 && dag.spine.length === 0) return
    setOpenState((prev) => pruneOpenState(prev, dag))
  }, [dag])

  useEffect(() => {
    if (!persistReadyRef.current || !runId) return
    writeTraceTreePrefs(tileId, runId, openState)
  }, [tileId, runId, openState])

  useEffect(() => {
    if (!compareRunId) return
    if (!canCompare) {
      setCompareRunId(null)
      setCompareDag(null)
    }
  }, [compareRunId, canCompare])

  useEffect(() => {
    if (!compareRunId) {
      setCompareDag(null)
      return
    }
    let cancelled = false
    api
      .getRunTrace(compareRunId)
      .then((raw) => {
        if (cancelled) return
        const normalized = normalizeTraceWire(raw as unknown[])
        setCompareDag(buildTraceDag(normalized.entries, { createdAtMs: normalized.createdAtMs }))
      })
      .catch(() => {
        if (!cancelled) {
          setCompareDag(null)
          onExportError?.("Failed to load previous run trace")
        }
      })
    return () => {
      cancelled = true
    }
  }, [compareRunId, onExportError])

  useEffect(() => {
    if (!selectedScopeId && treeIndex.nodes.length > 0) {
      setSelectedScopeId(defaultSelectedScopeId(treeIndex))
      return
    }
    if (
      selectedScopeId &&
      !treeIndex.byScopeId.has(selectedScopeId) &&
      treeIndex.nodes.length > 0
    ) {
      setSelectedScopeId(defaultSelectedScopeId(treeIndex))
    }
  }, [treeIndex, selectedScopeId])

  useEffect(() => {
    if (!treeSearch) {
      if (hadSearchRef.current) {
        hadSearchRef.current = false
        setOpenState((prev) => openStateForFoldMode(dag, prev.foldMode))
      }
      searchSeedRef.current = ""
      return
    }
    hadSearchRef.current = true
    if (searchSeedRef.current === treeSearch.query) return
    searchSeedRef.current = treeSearch.query
    setOpenState((prev) => {
      const next: OpenState = {
        ...prev,
        calls: new Set(treeSearch.callHits.keys()),
        sent: new Set(prev.sent),
        received: new Set(prev.received),
      }
      for (const [i, hit] of treeSearch.callHits) {
        if (hit.inHistory) next.sent.add(i)
        if (hit.inReply) next.received.add(i)
        if (!hit.inHistory && !hit.inReply) {
          next.sent.add(i)
          next.received.add(i)
        }
      }
      for (const phaseId of treeSearch.visiblePhaseIds) next.phases.add(phaseId)
      for (const workId of treeSearch.matchedWorkIds) next.work.add(workId)
      if (treeSearch.contextVisible) {
        next.preamble = true
        if (treeSearch.contextPromptVisible) next.contextPrompt = true
        if (treeSearch.contextToolsVisible) next.contextTools = true
      }
      return next
    })
  }, [treeSearch, dag])

  function isNodeFolded(node: TraceTreeNode): boolean {
    if (node.kind === "context") return !openState.preamble
    if (node.kind === "phase" && node.phaseId) return !openState.phases.has(node.phaseId)
    if (node.kind === "call" && node.callIndex != null) return !openState.calls.has(node.callIndex)
    if (node.kind === "sent" && node.callIndex != null) return !openState.sent.has(node.callIndex)
    if (node.kind === "received" && node.callIndex != null) {
      return !openState.received.has(node.callIndex)
    }
    if (node.kind === "message" && node.messageKey) {
      return !openState.messages.has(node.messageKey)
    }
    if (node.kind === "work" && node.workId) return !openState.work.has(node.workId)
    return false
  }

  function onToggleFold(scopeId: string) {
    const node = treeIndex.byScopeId.get(scopeId)
    if (!node) return
    if (node.kind === "context") {
      setOpenState((prev) => {
        const opening = !prev.preamble
        return {
          ...prev,
          preamble: opening,
          ...(opening ? { contextPrompt: true, contextTools: true } : {}),
        }
      })
      return
    }
    if (node.kind === "phase" && node.phaseId) {
      setOpenState((prev) => {
        const phases = new Set(prev.phases)
        if (phases.has(node.phaseId!)) phases.delete(node.phaseId!)
        else phases.add(node.phaseId!)
        return { ...prev, phases }
      })
      return
    }
    if (node.kind === "call" && node.callIndex != null) {
      setOpenState((prev) => {
        const calls = new Set(prev.calls)
        if (calls.has(node.callIndex!)) calls.delete(node.callIndex!)
        else calls.add(node.callIndex!)
        return { ...prev, calls }
      })
      return
    }
    if (node.kind === "sent" && node.callIndex != null) {
      setOpenState((prev) => {
        const sent = new Set(prev.sent)
        if (sent.has(node.callIndex!)) sent.delete(node.callIndex!)
        else sent.add(node.callIndex!)
        return { ...prev, sent }
      })
      return
    }
    if (node.kind === "received" && node.callIndex != null) {
      setOpenState((prev) => {
        const received = new Set(prev.received)
        if (received.has(node.callIndex!)) received.delete(node.callIndex!)
        else received.add(node.callIndex!)
        return { ...prev, received }
      })
      return
    }
    if (node.kind === "message" && node.messageKey) {
      setOpenState((prev) => {
        const messages = new Set(prev.messages)
        if (messages.has(node.messageKey!)) messages.delete(node.messageKey!)
        else messages.add(node.messageKey!)
        return { ...prev, messages }
      })
      return
    }
    if (node.kind === "work" && node.workId) {
      setOpenState((prev) => {
        const work = new Set(prev.work)
        if (work.has(node.workId!)) work.delete(node.workId!)
        else work.add(node.workId!)
        return { ...prev, work }
      })
    }
  }

  function onSelectScope(scopeId: string, jumpToRootCause = false) {
    const resolved = resolveSelectionScopeId(treeIndex, scopeId, jumpToRootCause, dag)
    if (jumpToRootCause && resolved !== scopeId) {
      setOpenState((prev) => openStateRevealingScope(dag, prev, resolved))
    }
    setSelectedScopeId(resolved)
    setPlaygroundOpen(false)
  }

  function onJumpToRootCause(scopeId: string) {
    const deepest = findDeepestFailure(treeIndex, scopeId, dag)
    if (!deepest) return
    setOpenState((prev) => openStateRevealingScope(dag, prev, deepest))
    setSelectedScopeId(deepest)
  }

  function onFoldModeChange(mode: FoldMode) {
    setOpenState(openStateForFoldMode(dag, mode))
  }

  function onTogglePlayground() {
    setPlaygroundOpen((open) => {
      const next = !open
      if (next) {
        setCompareRunId(null)
        setCompareDag(null)
      }
      return next
    })
  }

  function onToggleCompare() {
    if (compareRunId) {
      setCompareRunId(null)
      setCompareDag(null)
      return
    }
    const prevId = previousRunInThread(runs, runId)
    if (!prevId) {
      onExportError?.("No prior run in this thread")
      return
    }
    setCompareRunId(prevId)
    setPlaygroundOpen(false)
  }

  function onCompareRunChange(nextRunId: string) {
    setCompareRunId(nextRunId)
    setPlaygroundOpen(false)
  }

  function estimateTreeRowSize(index: number): number {
    return traceTreeRowEstimateSize(treeIndex.nodes[index])
  }

  function treeItemKey(_index: number, node: TraceTreeNode): string {
    return node.scopeId
  }

  function renderTreeRow({ item: node }: { item: TraceTreeNode }) {
    return (
      <TraceTreeRow
        node={node}
        selected={selectedScopeId === node.scopeId}
        folded={isNodeFolded(node)}
        maxDurationMs={treeIndex.maxDurationMs}
        onSelect={(id, jump) => onSelectScope(id, jump ?? false)}
        onToggleFold={onToggleFold}
        onJumpToRootCause={onJumpToRootCause}
      />
    )
  }

  const searchStatus = treeSearch
    ? traceSearchSummary(treeSearch, dag, treeIndex.nodes.length)
    : null

  type MetaStat = { value: string; label?: string }
  const metaStats: MetaStat[] = []
  if (stats.callCount > 0) {
    metaStats.push({
      value: String(stats.callCount),
      label: stats.callCount === 1 ? "call" : "calls",
    })
  }
  if (stats.toolRunCount > 0) {
    metaStats.push({
      value: String(stats.toolRunCount),
      label: stats.toolRunCount === 1 ? "tool" : "tools",
    })
  }
  if (stats.phaseCount > 0) {
    metaStats.push({
      value: String(stats.phaseCount),
      label: stats.phaseCount === 1 ? "phase" : "phases",
    })
  }
  if (stats.totalDuration > 0) {
    metaStats.push({
      value: formatMs(stats.totalDuration),
      label: stats.timingBasis === "wall" ? "wall" : "llm",
    })
  }
  if (stats.promptTokens > 0 || stats.completionTokens > 0) {
    metaStats.push({ value: fmtTokens(stats.promptTokens), label: "in" })
    metaStats.push({ value: fmtTokens(stats.completionTokens), label: "out" })
  }
  const runStatus = runId
    ? runs.find((r) => r.id === runId)?.status
    : undefined
  const showMetaBand =
    metaStats.length > 0 || Boolean(runId || threadId || runStatus)

  return (
    <div className={`trace-dag trace-dag--split${isZen ? " trace-dag--zen" : ""} ${WIDGET_LOG_SHELL_CLASS}`}>
      <div className={WIDGET_LOG_STACK_CLASS}>
        {!isZen ? (
          <div className={WIDGET_REVIEW_CONTROLS_CLASS}>
          <div className={WIDGET_REVIEW_CONTROLS_INSET_CLASS}>
          <WidgetToolbar>
            <WidgetToolbarLeading>
              <SegmentToggle
                value={viewMode}
                options={[
                  { value: "tree", label: "Tree" },
                  { value: "waterfall", label: "Waterfall" },
                ]}
                onChange={(mode) => setViewMode(mode as ViewMode)}
                ariaLabel="Tree or waterfall view"
              />
            </WidgetToolbarLeading>
            <WidgetToolbarSearch
              value={search}
              onChange={setSearch}
              placeholder="Filter calls, tools, work…"
              onClear={() => setSearch("")}
            />
            <WidgetToolbarTrailing>
              {searchStatus ? (
                <BrowseCount filtered={0} total={0} text={searchStatus} />
              ) : null}
              <ReviewTreeFoldToggle
                foldMode={openState.foldMode}
                onFoldModeChange={onFoldModeChange}
                ariaLabel="Expand or collapse all trace scopes"
              />
              <TraceExportMenu
                target={
                  runId
                    ? { kind: "run", runId }
                    : threadId
                      ? { kind: "thread", threadId }
                      : null
                }
                onExported={onExportMessage}
                onError={onExportError}
              />
            </WidgetToolbarTrailing>
          </WidgetToolbar>
          </div>

          {showMetaBand ? (
            <div className={WIDGET_REVIEW_CONTROLS_INSET_CLASS}>
            {/* Same band chrome as Pipelines ActiveFilterChips (.widget-filter-band). */}
            <div className="widget-filter-band widget-review-meta">
              <div className="widget-review-meta__stats">
                {metaStats.length === 0 ? (
                  <span className="widget-review-meta__empty">No agent loop yet</span>
                ) : (
                  metaStats.map((stat) => (
                    <span
                      key={`${stat.value}:${stat.label ?? ""}`}
                      className="widget-review-meta__stat"
                    >
                      <span className="widget-review-meta__stat-value">{stat.value}</span>
                      {stat.label ? (
                        <span className="widget-review-meta__stat-label">{stat.label}</span>
                      ) : null}
                    </span>
                  ))
                )}
              </div>
              {(runId || threadId || runStatus) && (
                <div className="widget-review-meta__ids">
                  {runStatus ? (
                    <span
                      className={operationStatusPill(runStatus)}
                      title={`Run status: ${runStatus}`}
                    >
                      {runStatus}
                    </span>
                  ) : null}
                  {runId ? (
                    <span className="widget-review-meta__id-group">
                      <IdChip label="run" value={runId} tone="meta" />
                    </span>
                  ) : null}
                  {threadId ? (
                    <span className="widget-review-meta__id-group">
                      <IdChip label="thread" value={threadId} tone="meta" />
                    </span>
                  ) : null}
                </div>
              )}
            </div>
            </div>
          ) : null}
        </div>
        ) : null}

        <div className={`trace-body trace-split-body${isZen ? " trace-split-body--zen" : ""} ${WIDGET_LOG_BODY_CLASS}`}>
          {emptySlot ? (
            emptySlot
          ) : (
            <div className="trace-split-host relative min-h-0 flex-1 overflow-hidden">
              <div
                ref={splitShellRef}
                className={`trace-split-shell trace-split-shell--resizable entity-registry-shell widget-split-shell grid h-full min-h-0 overflow-hidden${isZen ? " trace-split-shell--zen" : ""}`}
                style={{
                  gridTemplateColumns: `${Math.round(splitRatio * 1000) / 10}% 4px minmax(0, 1fr)`,
                }}
              >
              <div
                className={`trace-split-tree widget-split-sidebar flex min-h-0 flex-col${isZen ? " trace-split-tree--zen" : ""}`}
              >
                {isZen ? (
                  <TraceZenHud
                    metaStats={metaStats}
                    runId={runId}
                    threadId={threadId}
                    search={search}
                    onSearchChange={setSearch}
                    searchOpen={zenSearchOpen}
                    onSearchOpenChange={setZenSearchOpen}
                    foldMode={openState.foldMode}
                    onFoldModeChange={onFoldModeChange}
                    viewMode={viewMode}
                    onExitZen={exitZen}
                  />
                ) : null}
                {runId && dag.hasData && treeSearch && treeIndex.nodes.length === 0 ? (
                  <p className="trace-empty px-2 py-3">No matches for “{query}”</p>
                ) : null}
                {runId && dag.hasData && viewMode === "tree" && (
                  <div className="trace-split-tree-table">
                    <div
                      className="trace-tree-header trace-split-header-row trace-split-header-row--secondary"
                      aria-hidden
                    >
                      <span className="trace-tree-header__node">Node</span>
                      <span className="trace-tree-header__metric">Latency</span>
                      <span className="trace-tree-header__metric">Tokens</span>
                    </div>
                    <div ref={treeScrollRef} className="trace-split-tree-scroll">
                      <VirtualList
                        items={treeIndex.nodes}
                        scrollRef={treeScrollRef}
                        estimateSize={estimateTreeRowSize}
                        getItemKey={treeItemKey}
                        overscan={TRACE_TREE_OVERSCAN}
                        adjustScrollOnResize={false}
                        renderItem={renderTreeRow}
                      />
                    </div>
                  </div>
                )}
                {runId && dag.hasData && viewMode === "waterfall" && (
                  <div ref={treeScrollRef} className="trace-split-tree-scroll">
                    <TraceWaterfallView
                      treeIndex={treeIndex}
                      selectedScopeId={selectedScopeId}
                      onSelect={(id) => onSelectScope(id, false)}
                    />
                  </div>
                )}
              </div>
              <div
                className="trace-split-handle"
                role="separator"
                aria-orientation="vertical"
                aria-valuenow={Math.round(splitRatio * 100)}
                aria-valuemin={Math.round(TRACE_SPLIT_MIN * 100)}
                aria-valuemax={Math.round(TRACE_SPLIT_MAX * 100)}
                onPointerDown={onSplitPointerDown}
                onPointerMove={onSplitPointerMove}
                onPointerUp={onSplitPointerUp}
                onPointerCancel={onSplitPointerCancel}
              />
              <div className="trace-split-detail widget-split-main flex min-h-0 min-w-0 flex-col overflow-hidden">
                <div className="widget-split-inset flex min-h-0 flex-1 flex-col overflow-hidden">
                  <TraceDetailInspector
                    dag={dag}
                    compareDag={compareDag}
                    treeIndex={treeIndex}
                    selectedScopeId={selectedScopeId}
                    runId={runId}
                    threadId={threadId}
                    playgroundOpen={playgroundOpen}
                    onTogglePlayground={onTogglePlayground}
                    compareRunId={compareRunId}
                    onToggleCompare={onToggleCompare}
                    priorRuns={priorRuns}
                    onCompareRunChange={onCompareRunChange}
                    canCompare={canCompare}
                    onNotify={onExportMessage}
                    onError={onExportError}
                    splitHeader={isZen}
                  />
                </div>
              </div>
            </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
