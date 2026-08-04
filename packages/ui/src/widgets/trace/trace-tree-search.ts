/**
 * Trace tree filter — calls, work, phases, context; drives index + auto-expand.
 */

import type {
  TraceCallSearchHit,
  TraceDag,
  TracePhaseNode,
  TraceSpineEntry,
  TraceWorkNode,
} from "../../lib/events/build-trace-view"
import { searchCall } from "./build-trace-dag"

export type TraceTreeSearch = {
  query: string
  callHits: Map<number, TraceCallSearchHit>
  matchedWorkIds: Set<string>
  visiblePhaseIds: Set<string>
  contextVisible: boolean
  contextPromptVisible: boolean
  contextToolsVisible: boolean
}

function collectWorksFromPhase(phase: TracePhaseNode, works: TraceWorkNode[]) {
  for (const child of phase.children ?? []) {
    if (child.kind === "work") works.push(child.work)
    else if (child.kind === "phase") collectWorksFromPhase(child.phase, works)
  }
}

export function collectWorksFromSpine(spine: TraceSpineEntry[]): TraceWorkNode[] {
  const works: TraceWorkNode[] = []
  for (const entry of spine) {
    if (entry.kind === "work") works.push(entry.work)
    if (entry.kind === "phase") collectWorksFromPhase(entry.phase, works)
  }
  return works
}

function collectPhasesFromPhase(phase: TracePhaseNode, phases: TracePhaseNode[]) {
  phases.push(phase)
  for (const child of phase.children ?? []) {
    if (child.kind === "phase") collectPhasesFromPhase(child.phase, phases)
  }
}

export function collectPhasesFromSpine(spine: TraceSpineEntry[]): TracePhaseNode[] {
  const phases: TracePhaseNode[] = []
  for (const entry of spine) {
    if (entry.kind === "phase") collectPhasesFromPhase(entry.phase, phases)
  }
  return phases
}

function workMatches(work: TraceWorkNode, q: string): boolean {
  if (work.title.toLowerCase().includes(q)) return true
  if (work.summary.toLowerCase().includes(q)) return true
  for (const tool of work.tools) {
    if (tool.name.toLowerCase().includes(q)) return true
    if (tool.id.toLowerCase().includes(q)) return true
    if (tool.resultText?.toLowerCase().includes(q)) return true
    if (JSON.stringify(tool.arguments).toLowerCase().includes(q)) return true
  }
  for (const note of work.notes) {
    if (note.label.toLowerCase().includes(q)) return true
    if (note.text.toLowerCase().includes(q)) return true
  }
  for (const entry of work.sqlQuality) {
    if (entry.toolName.toLowerCase().includes(q)) return true
    if (entry.validationCode?.toLowerCase().includes(q)) return true
    if (entry.connection.toLowerCase().includes(q)) return true
    if (entry.database?.toLowerCase().includes(q)) return true
    if (entry.phase.toLowerCase().includes(q)) return true
  }
  return false
}

function phaseMatches(phase: TracePhaseNode, q: string): boolean {
  for (const field of [phase.title, phase.summary, phase.leading, phase.family]) {
    if (field?.toLowerCase().includes(q)) return true
  }
  for (const detail of phase.details) {
    if (detail.kind === "event" && detail.text.toLowerCase().includes(q)) return true
    if (detail.kind === "step") {
      if (detail.name.toLowerCase().includes(q)) return true
      if (detail.type.toLowerCase().includes(q)) return true
    }
    if (detail.kind === "json" && detail.label.toLowerCase().includes(q)) return true
  }
  return false
}

function contextPromptMatches(dag: TraceDag, q: string): boolean {
  const prompts =
    dag.preamble.systemPrompts.length > 0
      ? dag.preamble.systemPrompts
      : dag.preamble.systemPrompt
        ? [dag.preamble.systemPrompt]
        : []
  if (prompts.length === 0) return false
  if (prompts.some((p) => p.toLowerCase().includes(q))) return true
  if ("context".includes(q) || "prompt".includes(q) || "system".includes(q)) return true
  return false
}

function contextToolsMatch(dag: TraceDag, q: string): boolean {
  if ("tools".includes(q) || "tool".includes(q)) return true
  return dag.preamble.tools.some(
    (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
  )
}

function phaseHasVisibleChild(
  phase: TracePhaseNode,
  callHits: Map<number, TraceCallSearchHit>,
  matchedWorkIds: Set<string>,
  matchedPhaseIds: Set<string>,
): boolean {
  for (const child of phase.children ?? []) {
    if (child.kind === "call" && callHits.has(child.callIndex)) return true
    if (child.kind === "work") {
      if (matchedWorkIds.has(child.work.id)) return true
      if (callHits.has(child.work.afterCallIndex)) return true
    }
    if (child.kind === "phase") {
      if (matchedPhaseIds.has(child.phase.id)) return true
      if (phaseHasVisibleChild(child.phase, callHits, matchedWorkIds, matchedPhaseIds)) {
        return true
      }
    }
  }
  return false
}

export function buildTraceTreeSearch(
  dag: TraceDag,
  rawQuery: string,
  runId: string | null,
  threadId: string | null,
): TraceTreeSearch | null {
  const query = rawQuery.trim()
  if (!query) return null

  const q = query.toLowerCase()
  const callHits = new Map<number, TraceCallSearchHit>()
  const matchedWorkIds = new Set<string>()
  const visiblePhaseIds = new Set<string>()

  const matchedRun = Boolean(runId && runId.toLowerCase().includes(q))
  const matchedThread = Boolean(threadId && threadId.toLowerCase().includes(q))

  if (matchedRun || matchedThread) {
    for (const call of dag.calls) {
      callHits.set(call.index, {
        reasons: [matchedRun ? "run id" : "thread id"],
        inHistory: false,
        inReply: false,
      })
    }
  } else {
    for (const call of dag.calls) {
      const hit = searchCall(call, query)
      if (hit) callHits.set(call.index, hit)
    }
  }

  for (const work of collectWorksFromSpine(dag.spine)) {
    if (workMatches(work, q)) matchedWorkIds.add(work.id)
  }

  for (const work of collectWorksFromSpine(dag.spine)) {
    if (callHits.has(work.afterCallIndex)) matchedWorkIds.add(work.id)
  }

  const contextPromptVisible = contextPromptMatches(dag, q)
  const contextToolsVisible = contextToolsMatch(dag, q)
  const contextVisible = contextPromptVisible || contextToolsVisible

  for (const phase of collectPhasesFromSpine(dag.spine)) {
    if (phaseMatches(phase, q)) visiblePhaseIds.add(phase.id)
  }
  for (const phase of collectPhasesFromSpine(dag.spine)) {
    if (
      visiblePhaseIds.has(phase.id) ||
      phaseHasVisibleChild(phase, callHits, matchedWorkIds, visiblePhaseIds)
    ) {
      visiblePhaseIds.add(phase.id)
    }
  }

  return {
    query,
    callHits,
    matchedWorkIds,
    visiblePhaseIds,
    contextVisible,
    contextPromptVisible,
    contextToolsVisible,
  }
}

export function traceSearchSummary(
  search: TraceTreeSearch,
  dag: TraceDag,
  visibleRowCount: number,
): string {
  if (visibleRowCount === 0) return "No matches"
  const parts: string[] = []
  if (search.callHits.size > 0) {
    parts.push(`${search.callHits.size} of ${dag.calls.length} calls`)
  }
  if (search.matchedWorkIds.size > 0 && search.callHits.size === 0) {
    parts.push(`${search.matchedWorkIds.size} work`)
  }
  if (search.contextVisible && search.callHits.size === 0 && search.matchedWorkIds.size === 0) {
    parts.push("context")
  }
  if (parts.length === 0) parts.push(`${visibleRowCount} rows`)
  return parts.join(" · ")
}
