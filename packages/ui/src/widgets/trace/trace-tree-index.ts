/**
 * Flat trace tree for master-detail layout — metrics, fold visibility, branch errors.
 */

import type {
  TraceCallNode,
  TraceCallSearchHit,
  TraceDag,
  TracePhaseNode,
  TraceSpineEntry,
  TraceToolCall,
  TraceWorkNode,
} from "../../lib/events/build-trace-view"
import { callToolOpenKey, workToolOpenKey, type OpenState } from "./open-state"
import { callReceivedSummary, callSentSummary } from "./trace-format"

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
  callHits: Map<number, TraceCallSearchHit> | null,
  query: string,
): void {
  if (query && callHits && !callHits.has(call.index)) return

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
    leading: `Call ${call.index + 1}`,
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
  callHits: Map<number, TraceCallSearchHit> | null,
  query: string,
  startOffsetMs: number,
): void {
  if (query && callHits && !callHits.has(work.afterCallIndex)) return

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
  callHits: Map<number, TraceCallSearchHit> | null,
  query: string,
  startOffsetMs: number,
): number {
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
      buildCallNodes(acc, call, depth + 1, phase.id, true, openState, callHits, query)
      if (call.durationMs != null) offset += call.durationMs
    } else {
      buildWorkNodes(acc, child.work, depth + 1, phase.id, openState, callHits, query, offset)
    }
  }
  return offset
}

function buildSpineNodes(
  acc: TraceTreeNode[],
  spine: TraceSpineEntry[],
  dag: TraceDag,
  openState: OpenState,
  callHits: Map<number, TraceCallSearchHit> | null,
  query: string,
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
        callHits,
        query,
        offsetMs,
      )
      continue
    }
    if (entry.kind === "work") {
      buildWorkNodes(acc, entry.work, 0, null, openState, callHits, query, offsetMs)
      continue
    }
    const call = dag.calls[entry.callIndex]
    if (!call) continue
    buildCallNodes(acc, call, 0, null, false, openState, callHits, query)
    if (call.durationMs != null) offsetMs += call.durationMs
  }
}

function buildContextNodes(
  acc: TraceTreeNode[],
  dag: TraceDag,
  openState: OpenState,
  query: string,
): void {
  const { preamble } = dag
  if (!preamble.systemPrompt && preamble.tools.length === 0) return

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

  const q = query.trim().toLowerCase()
  if (preamble.systemPrompt) {
    const matches = !q || preamble.systemPrompt.toLowerCase().includes(q)
    if (matches) {
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
  }

  const tools = !q
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

function annotateBranchErrors(index: TraceTreeIndex): void {
  const { nodes, childrenByParent } = index

  function descendantHasError(scopeId: string): boolean {
    const node = index.byScopeId.get(scopeId)
    if (!node) return false
    if (node.hasError || node.status === "failed") return true
    const kids = childrenByParent.get(scopeId) ?? []
    return kids.some((kid) => descendantHasError(kid))
  }

  for (const node of nodes) {
    if (!node.hasChildren) continue
    node.branchHasError = descendantHasError(node.scopeId)
  }
}

function annotateFailureSubtitles(index: TraceTreeIndex): void {
  function firstFailedDescendant(scopeId: string): TraceTreeNode | null {
    for (const kid of index.childrenByParent.get(scopeId) ?? []) {
      const node = index.byScopeId.get(kid)
      if (!node) continue
      if (node.hasError || node.status === "failed") return node
      const deeper = firstFailedDescendant(kid)
      if (deeper) return deeper
    }
    return null
  }

  for (const node of index.nodes) {
    if (!node.branchHasError || node.hasError) continue
    const failed = firstFailedDescendant(node.scopeId)
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
  query: string,
  callHits: Map<number, TraceCallSearchHit> | null,
): TraceTreeIndex {
  const nodes: TraceTreeNode[] = []
  buildContextNodes(nodes, dag, openState, query)
  buildSpineNodes(nodes, dag.spine, dag, openState, callHits, query)

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
  annotateBranchErrors(index)
  annotateFailureSubtitles(index)
  return index
}

/** Deepest failing descendant for one-click root-cause jump. */
export function findDeepestFailure(
  index: TraceTreeIndex,
  scopeId: string,
): string | null {
  const node = index.byScopeId.get(scopeId)
  if (!node) return null

  function walk(id: string): string {
    const current = index.byScopeId.get(id)
    if (!current) return id
    const kids = index.childrenByParent.get(id) ?? []
    let deepest = id
    let deepestDepth = current.depth
    for (const kid of kids) {
      const child = index.byScopeId.get(kid)
      if (!child) continue
      const failed = child.hasError || child.status === "failed"
      const branchFailed = child.branchHasError
      if (!failed && !branchFailed) continue
      const candidate = walk(kid)
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

  return walk(scopeId)
}

export function resolveSelectionScopeId(
  index: TraceTreeIndex,
  scopeId: string,
  jumpToRootCause: boolean,
): string {
  const node = index.byScopeId.get(scopeId)
  if (!node) return scopeId
  if (jumpToRootCause && node.branchHasError && !node.hasError) {
    return findDeepestFailure(index, scopeId) ?? scopeId
  }
  return scopeId
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
