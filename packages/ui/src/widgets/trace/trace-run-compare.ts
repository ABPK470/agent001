/**
 * Run-to-run compare — prior run selection, call alignment, diff snapshots.
 */

import type { TraceCallNode, TraceDag, TracePromptMessage, TraceToolCall } from "./build-trace-dag"
import type { TraceTreeNode } from "./trace-tree-index"

export type CompareRunRow = {
  id: string
  threadId?: string | null
  createdAt?: string
}

export type CallCompareSnapshot = {
  callIndex: number
  callLabel: string
  system: string
  sent: string
  output: string
  selectedMessage: string | null
}

function runCreatedAtMs(run: CompareRunRow): number {
  return run.createdAt ? Date.parse(run.createdAt) : 0
}

/** Runs in the same thread that started before the active run (newest prior first). */
export function priorRunsInThread(
  runs: CompareRunRow[],
  activeRunId: string | null,
): CompareRunRow[] {
  if (!activeRunId) return []
  const current = runs.find((r) => r.id === activeRunId)
  if (!current?.threadId) return []
  const currentMs = runCreatedAtMs(current)
  return runs
    .filter(
      (r) =>
        r.threadId === current.threadId &&
        r.id !== activeRunId &&
        runCreatedAtMs(r) < currentMs,
    )
    .sort((a, b) => runCreatedAtMs(b) - runCreatedAtMs(a))
}

/** Chronologically prior run in thread (immediate predecessor when viewing latest). */
export function previousRunInThread(
  runs: CompareRunRow[],
  activeRunId: string | null,
): string | null {
  return priorRunsInThread(runs, activeRunId)[0]?.id ?? null
}

function formatToolCalls(tools: TraceToolCall[]): string {
  return tools
    .map((t) => {
      const args = JSON.stringify(t.arguments, null, 2)
      return `${t.name}(${args})`
    })
    .join("\n")
}

function formatMessageBlock(msg: TracePromptMessage): string {
  const header = `[${msg.speaker || msg.role}]`
  const parts: string[] = [header]
  if (msg.content?.trim()) parts.push(msg.content.trim())
  if (msg.toolCalls?.length) parts.push(formatToolCalls(msg.toolCalls))
  if (msg.detail) parts.push(`(${msg.detail})`)
  return parts.join("\n")
}

export function formatSentMessages(messages: TracePromptMessage[]): string {
  const nonSystem = messages.filter((m) => m.role !== "system")
  if (nonSystem.length === 0) return ""
  return nonSystem.map(formatMessageBlock).join("\n\n")
}

function formatCallOutput(call: TraceCallNode): string {
  const parts: string[] = []
  if (call.content?.trim()) parts.push(call.content.trim())
  if (call.toolBranches.length > 0) {
    parts.push(`Tool calls:\n${formatToolCalls(call.toolBranches)}`)
  }
  return parts.join("\n\n")
}

/** Resolve which LLM call index to compare for a tree node. */
export function resolveCompareCallIndex(dag: TraceDag, node: TraceTreeNode): number | null {
  if (node.callIndex != null) return node.callIndex
  if (node.kind === "phase" && node.phaseId) {
    const entry = dag.spine.find((e) => e.kind === "phase" && e.phase.id === node.phaseId)
    if (entry?.kind !== "phase") return null
    for (const child of entry.phase.children ?? []) {
      if (child.kind === "call") return child.callIndex
      if (child.kind === "work") return child.work.afterCallIndex
    }
  }
  return null
}

export function nodeSupportsCompare(dag: TraceDag, node: TraceTreeNode): boolean {
  return resolveCompareCallIndex(dag, node) != null
}

function selectedMessageText(
  call: TraceCallNode,
  node: TraceTreeNode,
): string | null {
  if (node.kind !== "message" || !node.messageKey) return null
  const mi = Number(node.messageKey.split(":m:")[1])
  const msg = call.messages[mi]
  if (!msg) return null
  return formatMessageBlock(msg)
}

export function buildCallCompareSnapshot(
  dag: TraceDag,
  callIndex: number,
  node: TraceTreeNode,
): CallCompareSnapshot | null {
  const call = dag.calls[callIndex]
  if (!call) return null
  const system =
    call.messages.find((m) => m.role === "system")?.content ??
    dag.preamble.systemPrompt ??
    ""
  return {
    callIndex,
    callLabel: `Call ${callIndex + 1}${call.headline ? ` · ${call.headline}` : ""}`,
    system,
    sent: formatSentMessages(call.messages),
    output: formatCallOutput(call),
    selectedMessage: selectedMessageText(call, node),
  }
}

export function compareCallAvailability(
  compareDag: TraceDag,
  callIndex: number,
  node: TraceTreeNode,
): { compareSnapshot: CallCompareSnapshot | null; warning: string | null } {
  if (callIndex >= compareDag.calls.length) {
    return {
      compareSnapshot: null,
      warning: `Compare run has ${compareDag.calls.length} call${compareDag.calls.length === 1 ? "" : "s"} — no Call ${callIndex + 1} to compare`,
    }
  }
  const compareSnapshot = buildCallCompareSnapshot(compareDag, callIndex, node)
  return { compareSnapshot, warning: compareSnapshot ? null : "Call not found in compare run" }
}
