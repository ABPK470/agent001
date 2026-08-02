/**
 * Trace master-detail shell — metric tree (left) + sticky inspector (right).
 * Selection drives the inspector; chevrons fold tree children only.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { api } from "../../client/index"
import type { TraceEntry } from "@mia/shared-types"
import { VirtualList } from "../../components/VirtualList"
import { BrowseCount } from "../../components/BrowseStrip"
import { fmtTokens, formatMs } from "../../lib/util"
import { SegmentToggle } from "../entity-registry/SegmentToggle"
import {
  WIDGET_LOG_BODY_CLASS,
  WIDGET_LOG_SHELL_CLASS,
  WIDGET_LOG_STACK_CLASS,
  WIDGET_REVIEW_CONTROLS_CLASS,
  WidgetToolbar,
  WidgetToolbarLeading,
  WidgetToolbarSearch,
  WidgetToolbarTrailing,
} from "../widget-toolbar"
import {
  searchCall,
  buildTraceDag,
  type TraceCallSearchHit,
  type TraceDag,
} from "./build-trace-dag"
import { previousRunInThread } from "./trace-step-payload"
import {
  emptyOpen,
  seedLatest,
  type FoldMode,
  type OpenState,
} from "./open-state"
import { formatCostUsd } from "./trace-format"
import {
  buildTraceTreeIndex,
  defaultSelectedScopeId,
  findDeepestFailure,
  resolveSelectionScopeId,
  type TraceTreeNode,
} from "./trace-tree-index"
import { TraceDetailInspector } from "./TraceDetailInspector"
import { IdChip } from "./TraceCopy"
import { TraceExportMenu } from "./TraceExportMenu"
import { TraceTreeRow } from "./TraceTreeRow"
import { TraceWaterfallView } from "./TraceWaterfallView"

export const TRACE_TREE_OVERSCAN = 8

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
  runs: Array<{ id: string; threadId?: string | null; createdAt?: string }>
  emptySlot?: ReactNode
  onExportMessage?: (message: string) => void
  onExportError?: (message: string) => void
}) {
  const [search, setSearch] = useState("")
  const [openState, setOpenState] = useState<OpenState>(() => emptyOpen())
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>("tree")
  const [playgroundOpen, setPlaygroundOpen] = useState(false)
  const [compareRunId, setCompareRunId] = useState<string | null>(null)
  const [compareDag, setCompareDag] = useState<TraceDag | null>(null)
  const treeScrollRef = useRef<HTMLDivElement>(null)
  const seededRef = useRef(false)
  const searchSeedRef = useRef("")
  const prevRunIdRef = useRef(runId)

  const query = search.trim()
  const { stats } = dag

  const callHits = useMemo(() => {
    if (!query) return null
    const q = query.toLowerCase()
    const matchedRun = Boolean(runId && runId.toLowerCase().includes(q))
    const matchedThread = Boolean(threadId && threadId.toLowerCase().includes(q))
    const map = new Map<number, TraceCallSearchHit>()
    for (const call of dag.calls) {
      if (matchedRun || matchedThread) {
        map.set(call.index, {
          reasons: [matchedRun ? "run id" : "thread id"],
          inHistory: false,
          inReply: false,
        })
        continue
      }
      const hit = searchCall(call, query)
      if (hit) map.set(call.index, hit)
    }
    return map
  }, [dag.calls, query, runId, threadId])

  const treeIndex = useMemo(
    () => buildTraceTreeIndex(dag, openState, query, callHits),
    [dag, openState, query, callHits],
  )

  useEffect(() => {
    if (seededRef.current || (dag.calls.length === 0 && dag.spine.length === 0)) return
    seededRef.current = true
    setOpenState((prev) => {
      const next = seedLatest(dag.calls.length)
      const lastCall = dag.calls.length - 1
      const lastWork = [...dag.spine].reverse().find((e) => e.kind === "work")
      if (lastWork && lastWork.kind === "work") {
        next.work.add(lastWork.work.id)
      }
      for (const entry of dag.spine) {
        if (entry.kind !== "phase" || !entry.phase.children?.length) continue
        const ownsLatest = entry.phase.children.some((child) => {
          if (child.kind === "call") return child.callIndex === lastCall
          if (child.kind === "work") {
            next.work.add(child.work.id)
            return child.work.afterCallIndex === lastCall
          }
          return false
        })
        if (ownsLatest) next.phases.add(entry.phase.id)
      }
      return { ...next, foldMode: prev.foldMode }
    })
  }, [dag.calls.length, dag.spine])

  useEffect(() => {
    if (prevRunIdRef.current === runId) return
    prevRunIdRef.current = runId
    seededRef.current = false
    searchSeedRef.current = ""
    setOpenState(emptyOpen())
    setSelectedScopeId(null)
    setPlaygroundOpen(false)
    setCompareRunId(null)
    setCompareDag(null)
  }, [runId])

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
        setCompareDag(buildTraceDag(raw as TraceEntry[]))
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
    if (!query || !callHits) {
      searchSeedRef.current = ""
      return
    }
    if (searchSeedRef.current === query) return
    searchSeedRef.current = query
    setOpenState((prev) => {
      const next: OpenState = {
        ...prev,
        calls: new Set(callHits.keys()),
        sent: new Set(prev.sent),
        received: new Set(prev.received),
      }
      for (const [i, hit] of callHits) {
        if (hit.inHistory) next.sent.add(i)
        if (hit.inReply) next.received.add(i)
        if (!hit.inHistory && !hit.inReply) {
          next.sent.add(i)
          next.received.add(i)
        }
      }
      return next
    })
  }, [query, callHits])

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
      setOpenState((prev) => ({ ...prev, preamble: !prev.preamble }))
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
    const resolved = resolveSelectionScopeId(treeIndex, scopeId, jumpToRootCause)
    setSelectedScopeId(resolved)
    setPlaygroundOpen(false)
  }

  function onJumpToRootCause(scopeId: string) {
    const deepest = findDeepestFailure(treeIndex, scopeId)
    if (deepest) setSelectedScopeId(deepest)
  }

  function onFoldModeChange(mode: FoldMode) {
    if (mode === "expanded") {
      const workNodes = dag.spine.flatMap((e) => {
        if (e.kind === "work") return [e.work]
        if (e.kind === "phase") {
          return (e.phase.children ?? [])
            .filter((c): c is Extract<typeof c, { kind: "work" }> => c.kind === "work")
            .map((c) => c.work)
        }
        return []
      })
      setOpenState({
        preamble: true,
        contextPrompt: true,
        contextTools: true,
        calls: new Set(dag.calls.map((c) => c.index)),
        sent: new Set(dag.calls.map((c) => c.index)),
        received: new Set(dag.calls.map((c) => c.index)),
        messages: new Set(
          dag.calls.flatMap((c) => c.messages.map((_, mi) => `${c.index}:m:${mi}`)),
        ),
        tools: new Set(),
        phases: new Set(
          dag.spine.filter((e) => e.kind === "phase").map((e) => e.phase.id),
        ),
        work: new Set(workNodes.map((w) => w.id)),
        foldMode: "expanded",
      })
      return
    }
    setOpenState({ ...emptyOpen(), foldMode: "collapsed" })
  }

  function onToggleCompare() {
    if (compareRunId) {
      setCompareRunId(null)
      setCompareDag(null)
      setPlaygroundOpen(false)
      return
    }
    const prevId = previousRunInThread(runs, runId)
    if (!prevId) {
      onExportError?.("No previous run in this thread")
      return
    }
    setCompareRunId(prevId)
    setPlaygroundOpen(false)
  }

  function estimateTreeRowSize(): number {
    return 36
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

  const searchStatus =
    query && dag.calls.length > 0
      ? `${callHits?.size ?? 0} of ${dag.calls.length} calls`
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
    metaStats.push({ value: formatMs(stats.totalDuration) })
  }
  if (stats.totalCostUsd > 0) {
    metaStats.push({ value: formatCostUsd(stats.totalCostUsd), label: "cost" })
  }
  if (stats.promptTokens > 0 || stats.completionTokens > 0) {
    metaStats.push({ value: fmtTokens(stats.promptTokens), label: "in" })
    metaStats.push({ value: fmtTokens(stats.completionTokens), label: "out" })
  }
  const showMetaBand = metaStats.length > 0 || Boolean(runId || threadId)

  return (
    <div className={`trace-dag trace-dag--split ${WIDGET_LOG_SHELL_CLASS}`}>
      <div className={WIDGET_LOG_STACK_CLASS}>
        <div className={WIDGET_REVIEW_CONTROLS_CLASS}>
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
              <SegmentToggle
                value={openState.foldMode}
                options={[
                  { value: "expanded", label: "Expanded" },
                  { value: "collapsed", label: "Collapsed" },
                ]}
                onChange={onFoldModeChange}
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

          {showMetaBand && (
            <div className="widget-review-meta">
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
              {(runId || threadId) && (
                <div className="widget-review-meta__ids">
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
          )}
        </div>

        <div className={`trace-body trace-split-body ${WIDGET_LOG_BODY_CLASS}`}>
          {emptySlot ? (
            emptySlot
          ) : (
            <div className="trace-split-shell entity-registry-shell widget-split-shell grid min-h-0 flex-1 overflow-hidden">
              <div className="trace-split-tree widget-split-sidebar flex min-h-0 flex-col">
                {runId && dag.hasData && query && (callHits?.size ?? 0) === 0 ? (
                  <p className="trace-empty px-2 py-3">No matches for “{query}”</p>
                ) : null}
                {runId && dag.hasData && viewMode === "tree" && (
                  <>
                    <div className="trace-tree-header" aria-hidden>
                      <span className="trace-tree-header__chev" />
                      <span className="trace-tree-header__icon" />
                      <span className="trace-tree-header__name">Node</span>
                      <span className="trace-tree-header__metric">Latency</span>
                      <span className="trace-tree-header__metric">Tokens</span>
                      <span className="trace-tree-header__metric">Cost</span>
                      <span className="trace-tree-header__status" />
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
                  </>
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
                    onTogglePlayground={() => setPlaygroundOpen((v) => !v)}
                    compareRunId={compareRunId}
                    onToggleCompare={onToggleCompare}
                    onNotify={onExportMessage}
                    onError={onExportError}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
