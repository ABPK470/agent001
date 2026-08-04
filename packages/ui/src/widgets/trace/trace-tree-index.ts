/**
 * Flat trace tree for master-detail layout — metrics, fold visibility, branch errors.
 */

import type {
    TraceCallNode,
    TraceDag,
    TracePhaseNode,
    TraceSpineEntry,
    TraceToolCall,
    TraceWorkNode,
} from "../../lib/events/build-trace-view"
import { callToolOpenKey, workToolOpenKey, type OpenState } from "./open-state"
import { callReceivedSummary, callSentSummary } from "./trace-format"
import type { TraceTreeSearch } from "./trace-tree-search"

export type TraceSpanStatus = "success" | "failed" | "running" | "skipped"

export type TraceTreeNodeKind =
  | "context"
  | "prompt"
  | "tools"
  | "phase"
  | "call"
  | "sent"
  | "received"
  | "message"
  | "work"
  | "tool"

export type TraceTreeNode = {
  scopeId: string
  kind: TraceTreeNodeKind
  depth: number
  name: string
  subtitle: string | null
  leading: string | null
  durationMs: number | null
  startOffsetMs: number
  promptTokens: number
  completionTokens: number
  costUsd: number | null
  status: TraceSpanStatus
  hasError: boolean
  branchHasError: boolean
  hasChildren: boolean
  parentScopeId: string | null
  callIndex: number | null
  workId: string | null
  phaseId: string | null
  toolKey: string | null
  messageKey: string | null
}

export type TraceTreeIndex = {
  nodes: TraceTreeNode[]
  byScopeId: Map<string, TraceTreeNode>
  childrenByParent: Map<string, string[]>
  maxDurationMs: number
}

function callStatus(call: TraceCallNode): TraceSpanStatus {
  if (call.waiting) return "running"
  return "success"
}

function phaseStatus(phase: TracePhaseNode): TraceSpanStatus {
  if (phase.status === "error") return "failed"
  if (phase.status === "running") return "running"
  return "success"
}

function workStatus(work: TraceWorkNode): TraceSpanStatus {
  if (work.notes.some((n) => n.tone === "error")) return "failed"
  if (work.tools.some((t) => t.status === "error")) return "failed"
  if (work.tools.some((t) => t.status === "running" || !t.status)) return "running"
  if (work.tools.length === 0 && work.notes.length === 0) return "skipped"
  return "success"
}

function toolStatus(tool: TraceToolCall): TraceSpanStatus {
  if (tool.status === "error") return "failed"
  if (tool.status === "running" || !tool.status) return "running"
  if (tool.status === "proposed") return "skipped"
  return "success"
}

function callMetrics(call: TraceCallNode): Pick<
  TraceTreeNode,
  "durationMs" | "startOffsetMs" | "promptTokens" | "completionTokens" | "costUsd" | "subtitle"
> {
  return {
    durationMs: call.durationMs,
    startOffsetMs: call.startOffsetMs,
    promptTokens: call.usage?.promptTokens ?? 0,
    completionTokens: call.usage?.completionTokens ?? 0,
    costUsd: call.costUsd,
    subtitle: call.model,
  }
}

function pushNode(
  acc: TraceTreeNode[],
  node: TraceTreeNode,
) {
  acc.push(node)
}

function buildCallNodes(
  acc: TraceTreeNode[],
  call: TraceCallNode,
  depth: number,
  parentScopeId: string | null,
  _nested: boolean,
  openState: OpenState,
  search: TraceTreeSearch | null,
): void {
  if (search && !search.callHits.has(call.index)) return

  const scopeId = `call:${call.index}`
  const metrics = callMetrics(call)
  const status = callStatus(call)
  const hasToolChildren = call.toolBranches.length > 0
  const hasSentChildren = call.messages.length > 0 || call.messageCount > 0
  pushNode(acc, {
    scopeId,
    kind: "call",
    depth,
    name: call.headline,
    subtitle: metrics.subtitle,
    leading: `Call ${call.callOrdinal + 1}`,
    durationMs: metrics.durationMs,
    startOffsetMs: metrics.startOffsetMs,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    costUsd: metrics.costUsd,
    status,
    hasError: false,
    branchHasError: false,
    hasChildren: hasToolChildren || hasSentChildren || Boolean(call.content),
    parentScopeId,
    callIndex: call.index,
    workId: null,
    phaseId: null,
    toolKey: null,
    messageKey: null,
  })

  if (!openState.calls.has(call.index)) return

  const sentScopeId = `sent:${call.index}`
  pushNode(acc, {
    scopeId: sentScopeId,
    kind: "sent",
    depth: depth + 1,
    name: "Sent",
    subtitle: callSentSummary(call),
    leading: null,
    durationMs: null,
    startOffsetMs: metrics.startOffsetMs,
    promptTokens: metrics.promptTokens,
    completionTokens: 0,
    costUsd: null,
    status: "success",
    hasError: false,
    branchHasError: false,
    hasChildren: call.messages.length > 0,
    parentScopeId: scopeId,
    callIndex: call.index,
    workId: null,
    phaseId: null,
    toolKey: null,
    messageKey: null,
  })

  if (openState.sent.has(call.index)) {
    for (let mi = 0; mi < call.messages.length; mi++) {
      const msg = call.messages[mi]!
      const msgKey = `${call.index}:m:${mi}`
      pushNode(acc, {
        scopeId: `message:${msgKey}`,
        kind: "message",
        depth: depth + 2,
        name: msg.speaker,
        subtitle: msg.content ? msg.content.slice(0, 48) : "empty",
        leading: null,
        durationMs: null,
        startOffsetMs: metrics.startOffsetMs,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        status: "success",
        hasError: false,
        branchHasError: false,
        hasChildren: false,
        parentScopeId: sentScopeId,
        callIndex: call.index,
        workId: null,
        phaseId: null,
        toolKey: null,
        messageKey: msgKey,
      })
    }
  }

  const recvScopeId = `received:${call.index}`
  pushNode(acc, {
    scopeId: recvScopeId,
    kind: "received",
    depth: depth + 1,
    name: "Received",
    subtitle: callReceivedSummary(call),
    leading: null,
    durationMs: metrics.durationMs,
    startOffsetMs: metrics.startOffsetMs,
    promptTokens: 0,
    completionTokens: metrics.completionTokens,
    costUsd: metrics.costUsd,
    status,
    hasError: call.waiting,
    branchHasError: false,
    hasChildren: hasToolChildren,
    parentScopeId: scopeId,
    callIndex: call.index,
    workId: null,
    phaseId: null,
    toolKey: null,
    messageKey: null,
  })

  if (!openState.received.has(call.index)) return

  for (const tool of call.toolBranches) {
    const toolKey = callToolOpenKey(call.index, tool.id)
    pushNode(acc, {
      scopeId: toolKey,
      kind: "tool",
      depth: depth + 2,
      name: tool.name,
      subtitle: "proposed",
      leading: "Tool",
      durationMs: null,
      startOffsetMs: metrics.startOffsetMs,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      status: toolStatus(tool),
      hasError: tool.status === "error",
      branchHasError: false,
      hasChildren: false,
      parentScopeId: recvScopeId,
      callIndex: call.index,
      workId: null,
      phaseId: null,
      toolKey,
      messageKey: null,
    })
  }
}

function buildWorkNodes(
  acc: TraceTreeNode[],
  work: TraceWorkNode,
  depth: number,
  parentScopeId: string | null,
  openState: OpenState,
  search: TraceTreeSearch | null,
  startOffsetMs: number,
): void {
  if (
    search &&
    !search.matchedWorkIds.has(work.id) &&
    !search.callHits.has(work.afterCallIndex)
  ) {
    return
  }

  const status = workStatus(work)
  const hasChildren =
    work.tools.length > 0 || work.notes.length > 0 || work.sqlQuality.length > 0
  pushNode(acc, {
    scopeId: work.id,
    kind: "work",
    depth,
    name: work.title,
    subtitle: work.summary,
    leading: "Work",
    durationMs: work.durationMs,
    startOffsetMs: work.startOffsetMs,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: null,
    status,
    hasError: status === "failed",
    branchHasError: false,
    hasChildren,
    parentScopeId,
    callIndex: null,
    workId: work.id,
    phaseId: null,
    toolKey: null,
    messageKey: null,
  })

  if (!openState.work.has(work.id)) return

  for (const tool of work.tools) {
    const toolKey = workToolOpenKey(work.id, tool.id)
    pushNode(acc, {
      scopeId: toolKey,
      kind: "tool",
      depth: depth + 1,
      name: tool.name,
      subtitle: tool.status ?? "running",
      leading: "Tool",
      durationMs: null,
      startOffsetMs: work.startOffsetMs ?? startOffsetMs,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      status: toolStatus(tool),
      hasError: tool.status === "error",
      branchHasError: false,
      hasChildren: false,
      parentScopeId: work.id,
      callIndex: null,
      workId: work.id,
      phaseId: null,
      toolKey,
      messageKey: null,
    })
  }
}

function buildPhaseNodes(
  acc: TraceTreeNode[],
  phase: TracePhaseNode,
  depth: number,
  parentScopeId: string | null,
  dag: TraceDag,
  openState: OpenState,
  search: TraceTreeSearch | null,
  startOffsetMs: number,
): number {
  if (search && !search.visiblePhaseIds.has(phase.id)) return startOffsetMs
  const status = phaseStatus(phase)
  const hasChildren = Boolean(phase.children?.length)
  const name = phase.title || phase.leading || phase.family || "Phase"
  const leading =
    phase.title && phase.leading && phase.leading !== phase.title ? phase.leading : null
  pushNode(acc, {
    scopeId: phase.id,
    kind: "phase",
    depth,
    name,
    subtitle: phase.summary && phase.summary !== name ? phase.summary : null,
    leading,
    durationMs: phase.durationMs,
    startOffsetMs: phase.startOffsetMs,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: null,
    status,
    hasError: status === "failed",
    branchHasError: false,
    hasChildren,
    parentScopeId,
    callIndex: null,
    workId: null,
    phaseId: phase.id,
    toolKey: null,
    messageKey: null,
  })

  let offset = phase.startOffsetMs
  if (!openState.phases.has(phase.id) || !phase.children) return offset

  for (const child of phase.children) {
    if (child.kind === "call") {
      const call = dag.calls[child.callIndex]
      if (!call) continue
      buildCallNodes(acc, call, depth + 1, phase.id, true, openState, search)
      if (call.durationMs != null) offset += call.durationMs
    } else if (child.kind === "work") {
      buildWorkNodes(acc, child.work, depth + 1, phase.id, openState, search, offset)
    } else {
      offset = buildPhaseNodes(
        acc,
        child.phase,
        depth + 1,
        phase.id,
        dag,
        openState,
        search,
        offset,
      )
    }
  }
  return offset
}

function buildSpineNodes(
  acc: TraceTreeNode[],
  spine: TraceSpineEntry[],
  dag: TraceDag,
  openState: OpenState,
  search: TraceTreeSearch | null,
): void {
  let offsetMs = 0
  for (const entry of spine) {
    if (entry.kind === "phase") {
      offsetMs = buildPhaseNodes(
        acc,
        entry.phase,
        0,
        null,
        dag,
        openState,
        search,
        offsetMs,
      )
      continue
    }
    if (entry.kind === "work") {
      buildWorkNodes(acc, entry.work, 0, null, openState, search, offsetMs)
      continue
    }
    const call = dag.calls[entry.callIndex]
    if (!call) continue
    buildCallNodes(acc, call, 0, null, false, openState, search)
    if (call.durationMs != null) offsetMs += call.durationMs
  }
}

function buildContextNodes(
  acc: TraceTreeNode[],
  dag: TraceDag,
  openState: OpenState,
  search: TraceTreeSearch | null,
): void {
  const { preamble } = dag
  if (!preamble.systemPrompt && preamble.tools.length === 0) return
  if (search && !search.contextVisible) return

  const bits: string[] = []
  if (preamble.systemPrompt) bits.push("prompt")
  if (preamble.tools.length > 0) bits.push(`${preamble.tools.length} tools`)

  pushNode(acc, {
    scopeId: "context",
    kind: "context",
    depth: 0,
    name: "Context",
    subtitle: bits.join(" · ") || "empty",
    leading: null,
    durationMs: null,
    startOffsetMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: null,
    status: "success",
    hasError: false,
    branchHasError: false,
    hasChildren: Boolean(preamble.systemPrompt || preamble.tools.length),
    parentScopeId: null,
    callIndex: null,
    workId: null,
    phaseId: null,
    toolKey: null,
    messageKey: null,
  })

  if (!openState.preamble) return

  const q = search?.query.toLowerCase() ?? ""
  if (preamble.systemPrompt && (!search || search.contextPromptVisible)) {
    pushNode(acc, {
        scopeId: "prompt",
        kind: "prompt",
        depth: 1,
        name: "System prompt",
        subtitle: `${preamble.systemPrompt.length} chars`,
        leading: "Prompt",
        durationMs: null,
        startOffsetMs: 0,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        status: "success",
        hasError: false,
        branchHasError: false,
        hasChildren: false,
        parentScopeId: "context",
        callIndex: null,
        workId: null,
        phaseId: null,
        toolKey: null,
        messageKey: null,
    })
  }

  const tools =
    search && !search.contextToolsVisible
      ? []
      : !q
        ? preamble.tools
        : preamble.tools.filter(
            (t) =>
              t.name.toLowerCase().includes(q) ||
              t.description.toLowerCase().includes(q),
          )
  if (tools.length > 0 && openState.contextTools) {
    pushNode(acc, {
      scopeId: "tools",
      kind: "tools",
      depth: 1,
      name: "Resolved tools",
      subtitle: String(tools.length),
      leading: "Tools",
      durationMs: null,
      startOffsetMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      status: "success",
      hasError: false,
      branchHasError: false,
      hasChildren: false,
      parentScopeId: "context",
      callIndex: null,
      workId: null,
      phaseId: null,
      toolKey: null,
      messageKey: null,
    })
  }
}

/**
 * Branch-error flags from the full DAG — never from the fold/search-visible
 * tree. Folded children are omitted from the index; walking that index made
 * parent badges flip OK↔Err as the user expanded or selected into a branch.
 */
function collectBranchErrorScopeIds(dag: TraceDag): Set<string> {
  const out = new Set<string>()

  function mark(ids: readonly string[]) {
    for (const id of ids) out.add(id)
  }

  function walkTools(
    tools: TraceToolCall[],
    parentScopeIds: readonly string[],
  ): boolean {
    let failed = false
    for (const tool of tools) {
      if (tool.status === "error") failed = true
    }
    if (failed) mark(parentScopeIds)
    return failed
  }

  function walkWork(work: TraceWorkNode, ancestors: readonly string[]): boolean {
    const toolFailed = walkTools(work.tools, [...ancestors, work.id])
    const failed = toolFailed || workStatus(work) === "failed"
    if (failed) mark(ancestors)
    return failed
  }

  function walkCall(call: TraceCallNode, ancestors: readonly string[]): boolean {
    const callId = `call:${call.index}`
    const recvId = `received:${call.index}`
    const toolFailed = walkTools(call.toolBranches, [...ancestors, callId, recvId])
    if (toolFailed) mark(ancestors)
    return toolFailed
  }

  function walkPhase(phase: TracePhaseNode, ancestors: readonly string[]): boolean {
    let childFailed = false
    for (const child of phase.children ?? []) {
      if (child.kind === "call") {
        const call = dag.calls[child.callIndex]
        if (call && walkCall(call, [...ancestors, phase.id])) childFailed = true
      } else if (child.kind === "work") {
        if (walkWork(child.work, [...ancestors, phase.id])) childFailed = true
      } else if (walkPhase(child.phase, [...ancestors, phase.id])) {
        childFailed = true
      }
    }
    const failed = childFailed || phase.status === "error"
    if (failed) mark(ancestors)
    if (childFailed) out.add(phase.id)
    return failed
  }

  for (const entry of dag.spine) {
    if (entry.kind === "phase") walkPhase(entry.phase, [])
    else if (entry.kind === "work") walkWork(entry.work, [])
    else {
      const call = dag.calls[entry.callIndex]
      if (call) walkCall(call, [])
    }
  }
  return out
}

type FailedHint = { name: string; subtitle: string | null; scopeId: string }

function failedToolHint(
  tools: TraceToolCall[],
  scopeFor: (tool: TraceToolCall) => string,
): FailedHint | null {
  for (const tool of tools) {
    if (tool.status === "error") {
      return {
        name: tool.name,
        subtitle: tool.status ?? "error",
        scopeId: scopeFor(tool),
      }
    }
  }
  return null
}

function failedWorkHint(work: TraceWorkNode): FailedHint | null {
  const tool = failedToolHint(work.tools, (t) => workToolOpenKey(work.id, t.id))
  if (tool) return tool
  if (workStatus(work) === "failed") {
    const note = work.notes.find((n) => n.tone === "error")
    return {
      name: work.title,
      subtitle: note?.text ?? work.summary,
      scopeId: work.id,
    }
  }
  return null
}

function failedCallHint(call: TraceCallNode): FailedHint | null {
  return failedToolHint(call.toolBranches, (t) => callToolOpenKey(call.index, t.id))
}

function failedPhaseHint(dag: TraceDag, phase: TracePhaseNode): FailedHint | null {
  for (const child of phase.children ?? []) {
    if (child.kind === "call") {
      const call = dag.calls[child.callIndex]
      const hit = call ? failedCallHint(call) : null
      if (hit) return hit
    } else if (child.kind === "work") {
      const hit = failedWorkHint(child.work)
      if (hit) return hit
    } else {
      const hit = failedPhaseHint(dag, child.phase)
      if (hit) return hit
    }
  }
  return null
}

function findPhaseById(phase: TracePhaseNode, id: string): TracePhaseNode | null {
  if (phase.id === id) return phase
  for (const child of phase.children ?? []) {
    if (child.kind === "phase") {
      const found = findPhaseById(child.phase, id)
      if (found) return found
    }
  }
  return null
}

function findWorkById(dag: TraceDag, workId: string): TraceWorkNode | null {
  for (const entry of dag.spine) {
    if (entry.kind === "work" && entry.work.id === workId) return entry.work
    if (entry.kind === "phase") {
      const found = findWorkInPhase(entry.phase, workId)
      if (found) return found
    }
  }
  return null
}

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

/** First failed leaf under a scope — walks the DAG, not the folded tree. */
function firstFailedHintFromDag(dag: TraceDag, scopeId: string): FailedHint | null {
  if (scopeId.startsWith("call:")) {
    const call = dag.calls[Number(scopeId.slice("call:".length))]
    return call ? failedCallHint(call) : null
  }
  if (scopeId.startsWith("received:")) {
    const call = dag.calls[Number(scopeId.slice("received:".length))]
    return call ? failedCallHint(call) : null
  }
  if (scopeId.startsWith("sent:")) return null

  const work = findWorkById(dag, scopeId)
  if (work) return failedWorkHint(work)

  for (const entry of dag.spine) {
    if (entry.kind === "phase") {
      const phase = findPhaseById(entry.phase, scopeId)
      if (phase) return failedPhaseHint(dag, phase)
    } else if (entry.kind === "call") {
      const call = dag.calls[entry.callIndex]
      if (call && `call:${call.index}` === scopeId) return failedCallHint(call)
    }
  }
  return null
}

function annotateBranchErrors(index: TraceTreeIndex, dag: TraceDag): void {
  const branchErrors = collectBranchErrorScopeIds(dag)
  for (const node of index.nodes) {
    if (!node.hasChildren) continue
    // Phase already closed successfully — recovered child tool errors stay on
    // Work/Tool rows; do not paint the parent as unresolved Err.
    if (node.kind === "phase" && node.status === "success") {
      node.branchHasError = false
      continue
    }
    node.branchHasError = branchErrors.has(node.scopeId)
  }
}

function annotateFailureSubtitles(index: TraceTreeIndex, dag: TraceDag): void {
  for (const node of index.nodes) {
    if (!node.branchHasError || node.hasError) continue
    const failed = firstFailedHintFromDag(dag, node.scopeId)
    if (!failed) continue
    const hint = failed.subtitle?.trim() || failed.name
    const normalized = node.subtitle?.trim().toLowerCase()
    if (normalized === "done" || normalized === "success" || !node.subtitle) {
      node.subtitle = `failed — ${hint}`
    }
  }
}

export function buildTraceTreeIndex(
  dag: TraceDag,
  openState: OpenState,
  search: TraceTreeSearch | null,
): TraceTreeIndex {
  const nodes: TraceTreeNode[] = []
  buildContextNodes(nodes, dag, openState, search)
  buildSpineNodes(nodes, dag.spine, dag, openState, search)

  const byScopeId = new Map<string, TraceTreeNode>()
  const childrenByParent = new Map<string, string[]>()
  let maxDurationMs = 0

  for (const node of nodes) {
    byScopeId.set(node.scopeId, node)
    if (node.durationMs != null && node.durationMs > maxDurationMs) {
      maxDurationMs = node.durationMs
    }
    if (node.parentScopeId) {
      const kids = childrenByParent.get(node.parentScopeId) ?? []
      kids.push(node.scopeId)
      childrenByParent.set(node.parentScopeId, kids)
    }
  }

  const index: TraceTreeIndex = {
    nodes,
    byScopeId,
    childrenByParent,
    maxDurationMs: maxDurationMs || dag.stats.totalDuration || 1,
  }
  annotateBranchErrors(index, dag)
  annotateFailureSubtitles(index, dag)
  return index
}

/**
 * Deepest failing scope under `scopeId`. Uses the visible index when the
 * branch is open; otherwise resolves from the DAG (fold-independent).
 */
export function findDeepestFailure(
  index: TraceTreeIndex,
  scopeId: string,
  dag?: TraceDag,
): string | null {
  const node = index.byScopeId.get(scopeId)
  if (!node) return null

  function walkIndex(id: string): string | null {
    const current = index.byScopeId.get(id)
    if (!current) return null
    const kids = index.childrenByParent.get(id) ?? []
    let deepest: string | null = null
    let deepestDepth = -1
    for (const kid of kids) {
      const child = index.byScopeId.get(kid)
      if (!child) continue
      const failed = child.hasError || child.status === "failed"
      const branchFailed = child.branchHasError
      if (!failed && !branchFailed) continue
      const candidate = walkIndex(kid)
      if (!candidate) continue
      const candidateNode = index.byScopeId.get(candidate)
      if (candidateNode && candidateNode.depth >= deepestDepth) {
        deepest = candidate
        deepestDepth = candidateNode.depth
      }
    }
    if (current.hasError || current.status === "failed") {
      if (current.depth >= deepestDepth) return id
    }
    return deepest
  }

  const fromIndex = walkIndex(scopeId)
  if (fromIndex) return fromIndex
  if (!dag) return null
  return firstFailedHintFromDag(dag, scopeId)?.scopeId ?? null
}

export function resolveSelectionScopeId(
  index: TraceTreeIndex,
  scopeId: string,
  jumpToRootCause: boolean,
  dag?: TraceDag,
): string {
  const node = index.byScopeId.get(scopeId)
  if (!node) return scopeId
  if (jumpToRootCause && node.branchHasError && !node.hasError) {
    return findDeepestFailure(index, scopeId, dag) ?? scopeId
  }
  return scopeId
}

/** Open every ancestor so a jumped-to failure is present in the tree index. */
export function openStateRevealingScope(
  dag: TraceDag,
  prev: OpenState,
  targetScopeId: string,
): OpenState {
  const next: OpenState = {
    ...prev,
    calls: new Set(prev.calls),
    sent: new Set(prev.sent),
    received: new Set(prev.received),
    messages: new Set(prev.messages),
    tools: new Set(prev.tools),
    phases: new Set(prev.phases),
    work: new Set(prev.work),
  }

  function revealInPhase(phase: TracePhaseNode): boolean {
    let hit = phase.id === targetScopeId
    for (const child of phase.children ?? []) {
      if (child.kind === "phase" && revealInPhase(child.phase)) {
        hit = true
      } else if (child.kind === "work") {
        if (
          child.work.id === targetScopeId ||
          child.work.tools.some((t) => workToolOpenKey(child.work.id, t.id) === targetScopeId)
        ) {
          next.work.add(child.work.id)
          hit = true
        }
      } else if (child.kind === "call") {
        const call = dag.calls[child.callIndex]
        if (!call) continue
        if (
          `call:${call.index}` === targetScopeId ||
          `sent:${call.index}` === targetScopeId ||
          `received:${call.index}` === targetScopeId ||
          call.toolBranches.some((t) => callToolOpenKey(call.index, t.id) === targetScopeId)
        ) {
          next.calls.add(call.index)
          next.sent.add(call.index)
          next.received.add(call.index)
          hit = true
        }
      }
    }
    if (hit) next.phases.add(phase.id)
    return hit
  }

  for (const entry of dag.spine) {
    if (entry.kind === "phase") revealInPhase(entry.phase)
    else if (entry.kind === "work") {
      if (
        entry.work.id === targetScopeId ||
        entry.work.tools.some((t) => workToolOpenKey(entry.work.id, t.id) === targetScopeId)
      ) {
        next.work.add(entry.work.id)
      }
    } else {
      const call = dag.calls[entry.callIndex]
      if (!call) continue
      if (
        `call:${call.index}` === targetScopeId ||
        `sent:${call.index}` === targetScopeId ||
        `received:${call.index}` === targetScopeId ||
        call.toolBranches.some((t) => callToolOpenKey(call.index, t.id) === targetScopeId)
      ) {
        next.calls.add(call.index)
        next.sent.add(call.index)
        next.received.add(call.index)
      }
    }
  }
  return next
}

export function defaultSelectedScopeId(index: TraceTreeIndex): string | null {
  if (index.nodes.length === 0) return null
  for (let i = index.nodes.length - 1; i >= 0; i--) {
    const node = index.nodes[i]!
    if (node.kind === "call" || node.kind === "work" || node.kind === "phase") {
      return node.scopeId
    }
  }
  return index.nodes[0]!.scopeId
}
