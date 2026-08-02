/**
 * Extract replay / eval payloads from a selected trace tree node.
 */

import type { TraceDag } from "./build-trace-dag"
import { callToolOpenKey, workToolOpenKey } from "./open-state"
import type { TraceTreeNode } from "./trace-tree-index"

export type TraceStepPayload = {
  kind: string
  scopeId: string
  callIndex: number | null
  label: string
  input: Record<string, unknown>
  output: unknown
  metadata: Record<string, unknown>
}

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

export function buildTraceStepPayload(
  dag: TraceDag,
  node: TraceTreeNode,
): TraceStepPayload | null {
  if (node.kind === "call" && node.callIndex != null) {
    const call = dag.calls[node.callIndex]
    if (!call) return null
    const systemPrompt =
      call.messages.find((m) => m.role === "system")?.content ??
      dag.preamble.systemPrompt
    return {
      kind: "call",
      scopeId: node.scopeId,
      callIndex: call.index,
      label: call.headline,
      input: {
        systemPrompt,
        messages: call.messages,
        iteration: call.iteration,
      },
      output: {
        content: call.content,
        toolCalls: call.toolBranches,
        usage: call.usage,
      },
      metadata: { model: call.model, durationMs: call.durationMs },
    }
  }

  if (node.kind === "tool" && node.toolKey) {
    for (const call of dag.calls) {
      for (const tool of call.toolBranches) {
        if (callToolOpenKey(call.index, tool.id) !== node.toolKey) continue
        return {
          kind: "tool",
          scopeId: node.scopeId,
          callIndex: call.index,
          label: tool.name,
          input: { arguments: tool.arguments },
          output: { resultText: tool.resultText, status: tool.status },
          metadata: { proposed: true },
        }
      }
    }
    for (const entry of dag.spine) {
      const works =
        entry.kind === "work"
          ? [entry.work]
          : entry.kind === "phase"
            ? (entry.phase.children ?? [])
                .filter((c): c is Extract<typeof c, { kind: "work" }> => c.kind === "work")
                .map((c) => c.work)
            : []
      for (const work of works) {
        for (const tool of work.tools) {
          if (workToolOpenKey(work.id, tool.id) !== node.toolKey) continue
          return {
            kind: "tool",
            scopeId: node.scopeId,
            callIndex: work.afterCallIndex,
            label: tool.name,
            input: { arguments: tool.arguments },
            output: { resultText: tool.resultText, status: tool.status },
            metadata: { workId: work.id },
          }
        }
      }
    }
  }

  if (node.kind === "work" && node.workId) {
    const work = findWork(dag, node.workId)
    if (!work) return null
    return {
      kind: "work",
      scopeId: node.scopeId,
      callIndex: work.afterCallIndex,
      label: work.title,
      input: { tools: work.tools.map((t) => ({ name: t.name, arguments: t.arguments })) },
      output: { notes: work.notes, sqlQuality: work.sqlQuality },
      metadata: { summary: work.summary },
    }
  }

  if (node.kind === "message" && node.messageKey && node.callIndex != null) {
    const call = dag.calls[node.callIndex]
    const mi = Number(node.messageKey.split(":m:")[1])
    const msg = call?.messages[mi]
    if (!msg) return null
    return {
      kind: "message",
      scopeId: node.scopeId,
      callIndex: node.callIndex,
      label: msg.speaker,
      input: { role: msg.role, content: msg.content, speaker: msg.speaker },
      output: { toolCalls: msg.toolCalls },
      metadata: { messageIndex: mi },
    }
  }

  return null
}

export function previousRunInThread(
  runs: Array<{ id: string; threadId?: string | null; createdAt?: string }>,
  activeRunId: string | null,
): string | null {
  if (!activeRunId) return null
  const current = runs.find((r) => r.id === activeRunId)
  if (!current?.threadId) return null
  const siblings = runs
    .filter((r) => r.threadId === current.threadId && r.id !== activeRunId)
    .sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0
      return tb - ta
    })
  return siblings[0]?.id ?? null
}
