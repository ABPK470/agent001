/**
 * Sticky step detail inspector — header, tabs, error surface, action bar.
 */

import { useState } from "react"
import { api } from "../../client/index"
import { formatMs } from "../../lib/util"
import type { TraceDag } from "./build-trace-dag"
import { TraceCallDetail } from "./TraceCallDetail"
import { TraceContextDetail } from "./TraceContextDetail"
import { TraceMessageDetail } from "./TraceMessageDetail"
import { TracePhaseDetail } from "./TracePhaseDetail"
import { TraceRunDiff } from "./TraceRunDiff"
import { TraceStepPlayground } from "./TraceStepPlayground"
import { TraceToolDetail } from "./TraceToolDetail"
import { TraceWorkDetail } from "./TraceWorkDetail"
import { formatCostUsd, tokenPairLabel } from "./trace-format"
import { buildTraceStepPayload } from "./trace-step-payload"
import type { TraceTreeIndex, TraceTreeNode } from "./trace-tree-index"

function findWork(dag: TraceDag, workId: string) {
  for (const entry of dag.spine) {
    if (entry.kind === "work" && entry.work.id === workId) return entry.work
    if (entry.kind === "phase") {
      for (const child of entry.phase.children ?? []) {
        if (child.kind === "work" && child.work.id === workId) return child.work
      }
    }
  }
  return null
}

function findPhase(dag: TraceDag, phaseId: string) {
  const entry = dag.spine.find((e) => e.kind === "phase" && e.phase.id === phaseId)
  return entry?.kind === "phase" ? entry.phase : null
}

function inspectorHeader(node: TraceTreeNode): string {
  const bits: string[] = [node.name]
  if (node.subtitle && node.kind === "call") bits.unshift(node.subtitle)
  if (node.durationMs != null) bits.push(formatMs(node.durationMs))
  if (node.costUsd != null) bits.push(formatCostUsd(node.costUsd))
  if (node.promptTokens > 0 || node.completionTokens > 0) {
    bits.push(tokenPairLabel(node.promptTokens, node.completionTokens))
  }
  return bits.join("  ·  ")
}

function renderDetail(dag: TraceDag, node: TraceTreeNode) {
  if (node.kind === "call" && node.callIndex != null) {
    const call = dag.calls[node.callIndex]
    if (!call) return <p className="trace-empty">Call not found</p>
    return <TraceCallDetail call={call} dag={dag} />
  }
  if (node.kind === "sent" && node.callIndex != null) {
    const call = dag.calls[node.callIndex]
    if (!call) return <p className="trace-empty">Call not found</p>
    return <TraceCallDetail call={call} dag={dag} initialTab="input" />
  }
  if (node.kind === "received" && node.callIndex != null) {
    const call = dag.calls[node.callIndex]
    if (!call) return <p className="trace-empty">Call not found</p>
    return <TraceCallDetail call={call} dag={dag} initialTab="output" />
  }
  if (node.kind === "message" && node.callIndex != null && node.messageKey) {
    const call = dag.calls[node.callIndex]
    if (!call) return <p className="trace-empty">Call not found</p>
    return <TraceMessageDetail call={call} messageKey={node.messageKey} />
  }
  if (node.kind === "work" && node.workId) {
    const work = findWork(dag, node.workId)
    if (!work) return <p className="trace-empty">Work not found</p>
    return <TraceWorkDetail work={work} dag={dag} toolKey={node.toolKey} />
  }
  if (node.kind === "phase" && node.phaseId) {
    const phase = findPhase(dag, node.phaseId)
    if (!phase) return <p className="trace-empty">Phase not found</p>
    return (
      <TracePhaseDetail
        phase={phase}
        nodeStatus={node.status}
        nodeHasError={node.hasError}
      />
    )
  }
  if (node.kind === "tool" && node.toolKey) {
    return <TraceToolDetail dag={dag} toolKey={node.toolKey} />
  }
  if (node.kind === "context" || node.kind === "prompt" || node.kind === "tools") {
    return (
      <TraceContextDetail
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
  onNotify,
  onError,
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
  onNotify?: (message: string) => void
  onError?: (message: string) => void
}) {
  const [evalBusy, setEvalBusy] = useState(false)
  const node = selectedScopeId ? treeIndex.byScopeId.get(selectedScopeId) : null

  if (!node) {
    return (
      <div className="trace-detail trace-detail--empty">
        <p className="trace-empty">Select a step to inspect</p>
      </div>
    )
  }

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
    } catch (err: unknown) {
      onError?.(err instanceof Error ? err.message : "Failed to add to dataset")
    } finally {
      setEvalBusy(false)
    }
  }

  return (
    <div className="trace-detail">
      <div className="trace-detail__header">
        <div className="trace-detail__headline">{inspectorHeader(node)}</div>
        <div className="trace-detail__actions">
          <button
            type="button"
            className="trace-detail-action"
            onClick={onTogglePlayground}
            disabled={!runId}
          >
            {playgroundOpen ? "Close playground" : "Re-run in playground"}
          </button>
          <button
            type="button"
            className="trace-detail-action"
            disabled={!runId || evalBusy}
            onClick={onAddEval}
          >
            {evalBusy ? "Saving…" : "Add to evaluation dataset"}
          </button>
          <button
            type="button"
            className="trace-detail-action"
            onClick={onToggleCompare}
          >
            {compareRunId ? "Close diff" : "Compare with previous run"}
          </button>
        </div>
      </div>

      <div className="trace-detail__scroll">
        {playgroundOpen && runId ? (
          <TraceStepPlayground
            dag={dag}
            node={node}
            runId={runId}
            onError={onError}
          />
        ) : compareRunId ? (
          <TraceRunDiff
            dag={dag}
            compareDag={compareDag}
            node={node}
            compareRunId={compareRunId}
          />
        ) : (
          renderDetail(dag, node)
        )}
      </div>
    </div>
  )
}
