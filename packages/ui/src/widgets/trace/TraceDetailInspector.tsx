/**
 * Sticky step detail inspector — header, tabs, error surface, action bar.
 */

import { useEffect, useState } from "react"
import { api } from "../../client/index"
import type { TraceDag, TracePhaseNode, TraceWorkNode } from "./build-trace-dag"
import { TraceCallDetail } from "./TraceCallDetail"
import { TraceContextDetail } from "./TraceContextDetail"
import { TraceMessageDetail } from "./TraceMessageDetail"
import { TracePhaseDetail } from "./TracePhaseDetail"
import { TraceRunDiff } from "./TraceRunDiff"
import { TraceStepPlayground } from "./TraceStepPlayground"
import { TraceToolDetail } from "./TraceToolDetail"
import { TraceWorkDetail } from "./TraceWorkDetail"
import {
  TraceInspectorHeadline,
  TraceInspectorHeadlinePrimary,
  TraceInspectorHeadlineSecondary,
  inspectorActionKind,
} from "./TraceInspectorHeadline"
import { buildTraceStepPayload } from "./trace-step-payload"
import { type CompareRunRow } from "./trace-run-compare"
import { resolveTraceTool, traceToolCurl } from "./trace-tool-resolve"
import type { TraceTreeIndex, TraceTreeNode } from "./trace-tree-index"

function findWorkInPhase(phase: TracePhaseNode, workId: string): TraceWorkNode | null {
  for (const child of phase.children ?? []) {
    if (child.kind === "work" && child.work.id === workId) return child.work
    if (child.kind === "phase") {
      const found = findWorkInPhase(child.phase, workId)
      if (found) return found
    }
  }
  return null
}

function findWork(dag: TraceDag, workId: string): TraceWorkNode | null {
  for (const entry of dag.spine) {
    if (entry.kind === "work" && entry.work.id === workId) return entry.work
    if (entry.kind === "phase") {
      const found = findWorkInPhase(entry.phase, workId)
      if (found) return found
    }
  }
  return null
}

function findPhaseInTree(phase: TracePhaseNode, phaseId: string): TracePhaseNode | null {
  if (phase.id === phaseId) return phase
  for (const child of phase.children ?? []) {
    if (child.kind === "phase") {
      const found = findPhaseInTree(child.phase, phaseId)
      if (found) return found
    }
  }
  return null
}

function findPhase(dag: TraceDag, phaseId: string): TracePhaseNode | null {
  for (const entry of dag.spine) {
    if (entry.kind !== "phase") continue
    const found = findPhaseInTree(entry.phase, phaseId)
    if (found) return found
  }
  return null
}

function renderDetail(dag: TraceDag, node: TraceTreeNode) {
  if (node.kind === "call" && node.callIndex != null) {
    const call = dag.calls[node.callIndex]
    if (!call) return <p className="trace-empty">Call not found</p>
    return (
      <TraceCallDetail
        key={node.scopeId}
        call={call}
        dag={dag}
        initialTab="output"
      />
    )
  }
  if (node.kind === "sent" && node.callIndex != null) {
    const call = dag.calls[node.callIndex]
    if (!call) return <p className="trace-empty">Call not found</p>
    return (
      <TraceCallDetail
        key={node.scopeId}
        call={call}
        dag={dag}
        initialTab="input"
      />
    )
  }
  if (node.kind === "received" && node.callIndex != null) {
    const call = dag.calls[node.callIndex]
    if (!call) return <p className="trace-empty">Call not found</p>
    return (
      <TraceCallDetail
        key={node.scopeId}
        call={call}
        dag={dag}
        initialTab="output"
      />
    )
  }
  if (node.kind === "message" && node.callIndex != null && node.messageKey) {
    const call = dag.calls[node.callIndex]
    if (!call) return <p className="trace-empty">Call not found</p>
    return (
      <TraceMessageDetail
        key={node.scopeId}
        call={call}
        messageKey={node.messageKey}
      />
    )
  }
  if (node.kind === "work" && node.workId) {
    const work = findWork(dag, node.workId)
    if (!work) return <p className="trace-empty">Work not found</p>
    return (
      <TraceWorkDetail
        key={node.scopeId}
        work={work}
        dag={dag}
        toolKey={node.toolKey}
      />
    )
  }
  if (node.kind === "phase" && node.phaseId) {
    const phase = findPhase(dag, node.phaseId)
    if (!phase) return <p className="trace-empty">Phase not found</p>
    return (
      <TracePhaseDetail
        key={node.scopeId}
        phase={phase}
        nodeStatus={node.status}
        nodeHasError={node.hasError}
        branchHasError={node.branchHasError}
      />
    )
  }
  if (node.kind === "tool" && node.toolKey) {
    return <TraceToolDetail key={node.scopeId} dag={dag} toolKey={node.toolKey} />
  }
  if (node.kind === "context" || node.kind === "prompt" || node.kind === "tools") {
    return (
      <TraceContextDetail
        key={node.scopeId}
        dag={dag}
        scopeId={node.kind === "context" ? "context" : node.kind}
      />
    )
  }
  return <p className="trace-empty">Select a step</p>
}

export function TraceDetailInspector({
  dag,
  compareDag,
  treeIndex,
  selectedScopeId,
  runId,
  threadId,
  playgroundOpen,
  onTogglePlayground,
  compareRunId,
  onToggleCompare,
  priorRuns,
  onCompareRunChange,
  canCompare,
  onNotify,
  onError,
  splitHeader = false,
}: {
  dag: TraceDag
  compareDag: TraceDag | null
  treeIndex: TraceTreeIndex
  selectedScopeId: string | null
  runId: string | null
  threadId: string | null
  playgroundOpen: boolean
  onTogglePlayground: () => void
  compareRunId: string | null
  onToggleCompare: () => void
  priorRuns: CompareRunRow[]
  onCompareRunChange: (runId: string) => void
  canCompare: boolean
  onNotify?: (message: string) => void
  onError?: (message: string) => void
  /** Zen split pane — lock header to 2-row grid aligned with tree column. */
  splitHeader?: boolean
}) {
  const [evalBusy, setEvalBusy] = useState(false)
  const [evalAdded, setEvalAdded] = useState(false)
  const node = selectedScopeId ? treeIndex.byScopeId.get(selectedScopeId) : null

  useEffect(() => {
    setEvalAdded(false)
  }, [selectedScopeId])

  useEffect(() => {
    if (!evalAdded) return
    const timer = window.setTimeout(() => setEvalAdded(false), 2500)
    return () => window.clearTimeout(timer)
  }, [evalAdded])

  if (!node) {
    return (
      <div className="trace-detail trace-detail--empty">
        <p className="trace-empty">Select a step to inspect</p>
      </div>
    )
  }

  const actions = inspectorActionKind(node)
  const toolKey =
    node.kind === "tool"
      ? node.toolKey
      : node.kind === "work" && node.toolKey
        ? node.toolKey
        : null
  const tool = toolKey ? resolveTraceTool(dag, toolKey) : null
  const curl = tool ? traceToolCurl(tool) : null
  const showLlmPlayground = actions === "llm" && playgroundOpen && runId
  const showCompare = actions === "llm" && Boolean(compareRunId) && canCompare
  const compareAvailable = priorRuns.length > 0

  async function onAddEval() {
    if (!runId) return
    const payload = buildTraceStepPayload(dag, node!)
    if (!payload) {
      onError?.("This step cannot be captured yet")
      return
    }
    setEvalBusy(true)
    try {
      await api.addEvalDatasetEntry({
        runId,
        threadId,
        scopeId: payload.scopeId,
        kind: payload.kind,
        callIndex: payload.callIndex,
        label: payload.label,
        input: payload.input,
        output: payload.output,
        metadata: payload.metadata,
      })
      onNotify?.("Added to evaluation dataset")
      setEvalAdded(true)
    } catch (err: unknown) {
      onError?.(err instanceof Error ? err.message : "Failed to add to dataset")
    } finally {
      setEvalBusy(false)
    }
  }

  async function onCopyCurl() {
    if (!curl) return
    try {
      await navigator.clipboard.writeText(curl)
      onNotify?.("Copied curl command")
    } catch {
      onError?.("Could not copy to clipboard")
    }
  }

  function onTestTool() {
    if (!tool) return
    onNotify?.("Tool replay is not wired yet — use Copy as curl")
  }

  return (
    <div className="trace-detail">
      <div
        className={`trace-detail__header${splitHeader ? " trace-detail__header--split" : ""}`}
      >
        {splitHeader ? (
          <>
            <div className="trace-split-header-row trace-split-header-row--primary">
              <TraceInspectorHeadlinePrimary node={node} />
              <div className="trace-detail__actions">
                {actions === "tool" ? (
                  <>
                    <button
                      type="button"
                      className="trace-detail-action trace-detail-action--toolbar is-primary"
                      onClick={onTestTool}
                    >
                      Test tool
                    </button>
                    <button
                      type="button"
                      className="trace-detail-action trace-detail-action--toolbar"
                      disabled={!curl}
                      onClick={onCopyCurl}
                    >
                      Copy curl
                    </button>
                  </>
                ) : actions === "llm" ? (
                  <>
                    <button
                      type="button"
                      className={`trace-detail-action trace-detail-action--toolbar is-toggle${playgroundOpen ? " is-active" : ""}`}
                      aria-pressed={playgroundOpen}
                      onClick={onTogglePlayground}
                      disabled={!runId}
                    >
                      Playground
                    </button>
                    <button
                      type="button"
                      className={`trace-detail-action trace-detail-action--toolbar is-toggle${evalAdded ? " is-success" : ""}`}
                      disabled={!runId || evalBusy || evalAdded}
                      onClick={onAddEval}
                    >
                      {evalBusy ? "Saving…" : evalAdded ? "Added ✓" : "Add to eval"}
                    </button>
                    {canCompare ? (
                      <button
                        type="button"
                        className={`trace-detail-action trace-detail-action--toolbar is-toggle${compareRunId ? " is-active" : ""}`}
                        aria-pressed={Boolean(compareRunId)}
                        onClick={onToggleCompare}
                        disabled={!compareAvailable}
                        title={
                          compareAvailable
                            ? undefined
                            : "No prior run in this thread to compare against"
                        }
                      >
                        Compare
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
            <div className="trace-split-header-row trace-split-header-row--secondary trace-detail__header-row2">
              <TraceInspectorHeadlineSecondary node={node} />
            </div>
          </>
        ) : (
          <div className="trace-detail__header-top">
            <TraceInspectorHeadline node={node} />
            <div className="trace-detail__actions">
              {actions === "tool" ? (
                <>
                  <button
                    type="button"
                    className="trace-detail-action trace-detail-action--toolbar is-primary"
                    onClick={onTestTool}
                  >
                    Test tool
                  </button>
                  <button
                    type="button"
                    className="trace-detail-action trace-detail-action--toolbar"
                    disabled={!curl}
                    onClick={onCopyCurl}
                  >
                    Copy curl
                  </button>
                </>
              ) : actions === "llm" ? (
                <>
                  <button
                    type="button"
                    className={`trace-detail-action trace-detail-action--toolbar is-toggle${playgroundOpen ? " is-active" : ""}`}
                    aria-pressed={playgroundOpen}
                    onClick={onTogglePlayground}
                    disabled={!runId}
                  >
                    Playground
                  </button>
                  <button
                    type="button"
                    className={`trace-detail-action trace-detail-action--toolbar is-toggle${evalAdded ? " is-success" : ""}`}
                    disabled={!runId || evalBusy || evalAdded}
                    onClick={onAddEval}
                  >
                    {evalBusy ? "Saving…" : evalAdded ? "Added ✓" : "Add to eval"}
                  </button>
                  {canCompare ? (
                    <button
                      type="button"
                      className={`trace-detail-action trace-detail-action--toolbar is-toggle${compareRunId ? " is-active" : ""}`}
                      aria-pressed={Boolean(compareRunId)}
                      onClick={onToggleCompare}
                      disabled={!compareAvailable}
                      title={
                        compareAvailable
                          ? undefined
                          : "No prior run in this thread to compare against"
                      }
                    >
                      Compare
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <div className="trace-detail__scroll">
        {showLlmPlayground ? (
          <TraceStepPlayground
            dag={dag}
            node={node}
            runId={runId}
            onError={onError}
          />
        ) : showCompare && compareRunId ? (
          <TraceRunDiff
            dag={dag}
            compareDag={compareDag}
            node={node}
            compareRunId={compareRunId}
            currentRunId={runId}
            priorRuns={priorRuns}
            onCompareRunChange={onCompareRunChange}
          />
        ) : (
          renderDetail(dag, node)
        )}
      </div>
    </div>
  )
}
