/**
 * Explicit open/fold state for the Trace outline.
 * One object — no nested closure state.
 *
 * Tool rows reuse the same toolCallId under Call (proposed) and Work
 * (executed). Open keys MUST be parent-scoped or one toggle opens both.
 */

import type { TraceDag } from "./build-trace-dag"

export type FoldMode = "expanded" | "collapsed"

export type OpenState = {
  preamble: boolean
  /** Context subsections — collapse Prompt / Tools as wholes. */
  contextPrompt: boolean
  contextTools: boolean
  calls: Set<number>
  sent: Set<number>
  received: Set<number>
  messages: Set<string>
  /** Parent-scoped tool keys — see callToolOpenKey / workToolOpenKey. */
  tools: Set<string>
  phases: Set<string>
  work: Set<string>
  foldMode: FoldMode
}

/** Proposed tool under Call → Received. */
export function callToolOpenKey(callIndex: number, toolId: string): string {
  return `call:${callIndex}:tool:${toolId}`
}

/** Executed tool under a Work card. */
export function workToolOpenKey(workId: string, toolId: string): string {
  return `${workId}:tool:${toolId}`
}

export function emptyOpen(): OpenState {
  return {
    preamble: false,
    contextPrompt: false,
    contextTools: false,
    calls: new Set(),
    sent: new Set(),
    received: new Set(),
    messages: new Set(),
    tools: new Set(),
    phases: new Set(),
    work: new Set(),
    foldMode: "collapsed",
  }
}

export function seedLatest(callCount: number): OpenState {
  const next = emptyOpen()
  if (callCount === 0) return next
  next.calls.add(callCount - 1)
  return next
}

function collectWorkIdsFromPhase(
  phase: import("./build-trace-dag").TracePhaseNode,
  ids: string[],
) {
  for (const child of phase.children ?? []) {
    if (child.kind === "work") ids.push(child.work.id)
    else if (child.kind === "phase") collectWorkIdsFromPhase(child.phase, ids)
  }
}

function collectWorkIds(dag: TraceDag): string[] {
  const ids: string[] = []
  for (const entry of dag.spine) {
    if (entry.kind === "work") ids.push(entry.work.id)
    if (entry.kind === "phase") collectWorkIdsFromPhase(entry.phase, ids)
  }
  return ids
}

function collectPhaseIdsFromPhase(
  phase: import("./build-trace-dag").TracePhaseNode,
  ids: string[],
) {
  ids.push(phase.id)
  for (const child of phase.children ?? []) {
    if (child.kind === "phase") collectPhaseIdsFromPhase(child.phase, ids)
  }
}

function collectPhaseIds(dag: TraceDag): string[] {
  const ids: string[] = []
  for (const entry of dag.spine) {
    if (entry.kind === "phase") collectPhaseIdsFromPhase(entry.phase, ids)
  }
  return ids
}

/** Expand every trace scope — same shape as toolbar Expanded toggle. */
export function expandedOpenState(dag: TraceDag): OpenState {
  return {
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
    phases: new Set(collectPhaseIds(dag)),
    work: new Set(collectWorkIds(dag)),
    foldMode: "expanded",
  }
}

/** Collapse every trace scope — same shape as toolbar Collapsed toggle. */
export function collapsedOpenState(): OpenState {
  return { ...emptyOpen(), foldMode: "collapsed" }
}

export function openStateForFoldMode(dag: TraceDag, mode: FoldMode): OpenState {
  return mode === "expanded" ? expandedOpenState(dag) : collapsedOpenState()
}
